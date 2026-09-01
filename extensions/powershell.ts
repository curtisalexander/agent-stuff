// Job tool API shape (pwsh-start-job / get / stop / remove / get-output, the
// "null" discard sentinel, merged-by-default logging, and UTF-8 prefix) is
// adapted from @marcfargas/pi-powershell (MIT). Implementation is
// Node-native (child_process.spawn with detached + fd redirection) rather than
// PowerShell's Start-Process.
//   https://github.com/marcfargas/pi-powershell
import {
	createBashToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateTail,
	type BashOperations,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, openSync, writeSync } from "node:fs";
import { access, chmod, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";

const DEFAULT_SHELL = process.env.POWERSHELL_BIN || "pwsh";
const IS_WINDOWS = process.platform === "win32";
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const EXIT_STDIO_GRACE_MS = 100;
const POWERSHELL_PROBE_TIMEOUT_MS = 5_000;

const UTF8_PREFIX =
	"[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); " +
	"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
	"$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n";

const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let jobsDirPromise: Promise<string> | null = null;
let powershellAvailabilityPromise: Promise<boolean> | null = null;

async function getJobsDir(): Promise<string> {
	if (!jobsDirPromise) {
		const dir = join(tmpdir(), `pi-powershell-jobs-${INSTANCE_ID}`);
		jobsDirPromise = mkdir(dir, { recursive: true, mode: 0o700 })
			.then(() => chmod(dir, 0o700))
			.then(() => dir);
	}
	return jobsDirPromise;
}

async function removeJobsDir(): Promise<void> {
	const currentPromise = jobsDirPromise;
	if (!currentPromise) return;
	const dir = await currentPromise;
	await rm(dir, { recursive: true, force: true });
	if (jobsDirPromise === currentPromise) jobsDirPromise = null;
}

function resolveWorkingDirectory(cwd: string, inputCwd?: string): string {
	if (!inputCwd) return cwd;
	const trimmed = inputCwd.startsWith("@") ? inputCwd.slice(1) : inputCwd;
	return resolve(cwd, trimmed);
}

function wrapCommand(command: string): string {
	return UTF8_PREFIX + command;
}

// stdout and stderr are independent byte streams. Decode each one separately
// before forwarding it to a shared consumer; otherwise an intervening chunk
// from the other stream can corrupt a split multibyte UTF-8 character. The
// TextDecoder also consumes one UTF-8 BOM at the start of each stream.
function forwardUtf8Stream(stream: Readable, onData: (data: Buffer) => void): Promise<void> {
	const decoder = new TextDecoder("utf-8");
	return new Promise((resolveForward, rejectForward) => {
		let settled = false;
		const cleanup = () => {
			stream.removeListener("data", onChunk);
			stream.removeListener("end", onEnd);
			stream.removeListener("close", onEnd);
			stream.removeListener("error", onError);
		};
		const emit = (text: string) => {
			if (text) onData(Buffer.from(text, "utf8"));
		};
		const finish = () => {
			if (settled) return;
			settled = true;
			cleanup();
			try {
				emit(decoder.decode());
				resolveForward();
			} catch (error) {
				rejectForward(error);
			}
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			stream.resume();
			rejectForward(error);
		};
		const onChunk = (chunk: Buffer) => {
			try {
				emit(decoder.decode(chunk, { stream: true }));
			} catch (error) {
				fail(error);
			}
		};
		const onEnd = () => finish();
		const onError = (error: Error) => fail(error);
		stream.on("data", onChunk);
		stream.once("end", onEnd);
		stream.once("close", onEnd);
		stream.once("error", onError);
	});
}

function writeAll(fd: number, data: Buffer): void {
	let offset = 0;
	while (offset < data.length) {
		const written = writeSync(fd, data, offset, data.length - offset);
		if (written === 0) throw new Error("Could not write captured PowerShell output.");
		offset += written;
	}
}

export function probePowerShell(shell = DEFAULT_SHELL): Promise<boolean> {
	return new Promise((resolveProbe) => {
		let settled = false;
		let child: ChildProcess;
		let timeoutId: NodeJS.Timeout | undefined;
		const finish = (available: boolean) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			resolveProbe(available);
		};
		try {
			child = spawn(
				shell,
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"if ($PSVersionTable.PSVersion.Major -ge 7) { exit 0 } else { exit 1 }",
				],
				{ stdio: "ignore", windowsHide: true },
			);
		} catch {
			finish(false);
			return;
		}
		timeoutId = setTimeout(() => {
			child.kill();
			finish(false);
		}, POWERSHELL_PROBE_TIMEOUT_MS);
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
	});
}

function createPiEnvironment(ctx: ExtensionContext): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	const sessionId = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionId) env.PI_SESSION_ID = sessionId;
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL") {
	try {
		process.kill(-pid, signal);
	} catch {
		// The process group exited between the existence check and signal.
	}
}

function childHasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processGroupExists(pid) && Date.now() < deadline) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	return !processGroupExists(pid);
}

async function taskkill(pid: number, force: boolean): Promise<number> {
	return new Promise((resolveKill) => {
		const args = ["/PID", String(pid), "/T"];
		if (force) args.push("/F");
		const killer = spawn("taskkill.exe", args, { stdio: "ignore", windowsHide: true });
		killer.once("error", () => resolveKill(-1));
		killer.once("close", (code) => resolveKill(code ?? -1));
	});
}

async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
	if (!child.pid) return childHasExited(child);
	if (IS_WINDOWS) {
		const exitCode = await taskkill(child.pid, true);
		return exitCode === 0 || childHasExited(child);
	}
	if (!processGroupExists(child.pid)) return true;
	signalProcessGroup(child.pid, "SIGTERM");
	if (await waitForProcessGroupExit(child.pid, 3_000)) return true;
	signalProcessGroup(child.pid, "SIGKILL");
	return waitForProcessGroupExit(child.pid, 3_000);
}

// Mirrors Pi's bash wait semantics: after the shell exits, keep accepting late
// output while inherited pipes are active, but do not hang forever on quiet
// descendants that retain a pipe handle.
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolveWait, rejectWait) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let idleTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;
		const cleanup = () => {
			if (idleTimer) clearTimeout(idleTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolveWait(code);
		};
		const maybeFinish = () => {
			if (exited && stdoutEnded && stderrEnded) finish(exitCode);
		};
		const armIdleTimer = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => finish(exitCode), EXIT_STDIO_GRACE_MS);
		};
		const onData = () => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinish();
		};
		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinish();
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectWait(error);
		};
		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinish();
			if (!settled) armIdleTimer();
		};
		const onClose = (code: number | null) => finish(code);
		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

const powershellOperations: BashOperations = {
	async exec(command, cwd, { onData, signal, timeout, env }) {
		const timeoutMs = resolveTimeoutMs(timeout);
		if (signal?.aborted) throw new Error("aborted");
		try {
			await access(cwd);
		} catch {
			throw new Error(`Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`);
		}
		if (signal?.aborted) throw new Error("aborted");

		const child = spawn(
			DEFAULT_SHELL,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", wrapCommand(command)],
			{
				cwd,
				env,
				detached: !IS_WINDOWS,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		let outputError: unknown;
		const outputDone = Promise.all(
			[child.stdout, child.stderr]
				.filter((stream): stream is Readable => stream !== null)
				.map((stream) => forwardUtf8Stream(stream, onData)),
		).catch((error) => {
			outputError = error;
		});

		let timedOut = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let termination: Promise<boolean> | undefined;
		const terminate = () => (termination ??= terminateProcessTree(child));
		const onAbort = () => void terminate();
		try {
			if (timeoutMs !== undefined) {
				timeoutId = setTimeout(() => {
					timedOut = true;
					void terminate();
				}, timeoutMs);
			}
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
			const exitCode = await waitForChildProcess(child);
			await outputDone;
			if (termination) await termination;
			if (signal?.aborted) throw new Error("aborted");
			if (timedOut) throw new Error(`timeout:${timeout}`);
			if (outputError) throw outputError;
			return { exitCode };
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
			if (signal) signal.removeEventListener("abort", onAbort);
		}
	},
};

interface JobSummary {
	name: string;
	status: "running" | "exited";
	pid: number;
	exitCode: number | null;
	startedAt: number;
	endedAt: number | null;
	mergedPath: string | null;
	stdoutPath: string | null;
	stderrPath: string | null;
}

interface JobRecord {
	name: string;
	pid: number;
	command: string;
	cwd: string;
	startedAt: number;
	endedAt: number | null;
	exitCode: number | null;
	mergedPath: string | null;
	stdoutPath: string | null;
	stderrPath: string | null;
	ownedLogPaths: string[];
	status: "running" | "exited";
	child: ChildProcess;
	outputDone: Promise<void>;
	outputError: Error | null;
	trackingStopped: boolean;
}

const jobs = new Map<string, JobRecord>();
const startingJobs = new Set<string>();
const startingJobOperations = new Set<Promise<void>>();
let shuttingDown = false;

type JobStreamSpec = { kind: "merged" } | { kind: "discard" } | { kind: "file"; path: string; owned: boolean };

function resolveJobStream(
	jobsDir: string,
	cwd: string,
	name: string,
	slot: "stdout" | "stderr",
	raw: string | undefined,
	bothDefault: boolean,
): JobStreamSpec {
	if (bothDefault) return { kind: "merged" };
	if (raw === "null") return { kind: "discard" };
	if (raw && raw !== "default") {
		return { kind: "file", path: isAbsolute(raw) ? raw : resolve(cwd, raw), owned: false };
	}
	return { kind: "file", path: join(jobsDir, `${name}-${slot}.log`), owned: true };
}

async function readJobFile(path: string, maxLines: number, maxBytes: number) {
	let file;
	try {
		file = await open(path, "r");
		const { size } = await file.stat();
		const start = Math.max(0, size - maxBytes - 4);
		const buffer = Buffer.alloc(size - start);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		let utf8Start = 0;
		while (utf8Start < bytesRead && (buffer[utf8Start] & 0xc0) === 0x80) utf8Start++;
		const candidate = buffer.subarray(utf8Start, bytesRead);
		const completeLength = completeUtf8PrefixLength(candidate);
		const truncation = truncateTail(candidate.subarray(0, completeLength).toString("utf8"), {
			maxLines,
			maxBytes,
		});
		if (start > 0) {
			truncation.truncated = true;
			truncation.truncatedBy = "bytes";
			truncation.totalBytes = size;
		}
		return { ...truncation, totalLinesKnown: start === 0 };
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw err;
	} finally {
		await file?.close();
	}
}

function completeUtf8PrefixLength(buffer: Buffer): number {
	if (buffer.length === 0) return 0;
	let lead = buffer.length - 1;
	while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead--;
	if (lead < 0) return 0;
	const byte = buffer[lead];
	const expectedLength = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : byte < 0xf8 ? 4 : 1;
	return buffer.length - lead < expectedLength ? lead : buffer.length;
}

async function readJobFileFromCursor(path: string, offset: number, maxLines: number, maxBytes: number) {
	let file;
	try {
		file = await open(path, "r");
		const { size } = await file.stat();
		const requestedOffset = Math.min(offset, size);
		const buffer = Buffer.alloc(Math.min(size - requestedOffset, maxBytes + 3));
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, requestedOffset + bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		let utf8Start = 0;
		while (utf8Start < bytesRead && (buffer[utf8Start] & 0xc0) === 0x80) utf8Start++;
		const candidate = buffer.subarray(utf8Start, Math.min(bytesRead, utf8Start + maxBytes));
		const completeLength = completeUtf8PrefixLength(candidate);
		let content = candidate.subarray(0, completeLength).toString("utf8");
		let newlineCount = 0;
		for (let index = 0; index < content.length; index++) {
			if (content.charCodeAt(index) !== 10) continue;
			newlineCount++;
			if (newlineCount === maxLines) {
				content = content.slice(0, index + 1);
				break;
			}
		}
		const startOffset = requestedOffset + utf8Start;
		const nextOffset = startOffset + Buffer.byteLength(content);
		return {
			content,
			startOffset,
			nextOffset,
			totalBytes: size,
			outputBytes: nextOffset - startOffset,
			outputLines: content.length === 0 ? 0 : content.split("\n").length,
			hasMore: nextOffset < size,
		};
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	} finally {
		await file?.close();
	}
}

async function removeJobFiles(job: JobRecord) {
	await Promise.all(job.ownedLogPaths.map((path) => rm(path, { force: true })));
}

function formatBool(v: boolean | undefined): string {
	return v ? "yes" : "no";
}

function summarizeJob(job: JobRecord, includeLogPaths = true): string {
	const runtimeMs = (job.endedAt ?? Date.now()) - job.startedAt;
	return [
		`Name: ${job.name}`,
		`Status: ${job.status}`,
		`PID: ${job.pid}`,
		`Exit code: ${job.exitCode ?? "n/a"}`,
		`Runtime: ${(runtimeMs / 1000).toFixed(1)}s`,
		`Command: ${job.command}`,
		`Cwd: ${job.cwd}`,
		job.outputError ? `Output capture error: ${job.outputError.message}` : undefined,
		includeLogPaths && job.mergedPath ? `Merged log: ${job.mergedPath}` : undefined,
		includeLogPaths && job.stdoutPath ? `Stdout log: ${job.stdoutPath}` : undefined,
		includeLogPaths && job.stderrPath ? `Stderr log: ${job.stderrPath}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

function markJobExited(job: JobRecord, code: number | null = job.child.exitCode) {
	job.status = "exited";
	job.exitCode = code ?? -1;
	job.endedAt ??= Date.now();
}

async function trackProcessGroupExit(job: JobRecord, code: number | null) {
	if (IS_WINDOWS || !processGroupExists(job.pid)) {
		await job.outputDone;
		markJobExited(job, code);
		return;
	}
	job.exitCode = code ?? -1;
	while (!job.trackingStopped && job.status === "running" && processGroupExists(job.pid)) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	if (!job.trackingStopped && job.status === "running") {
		await job.outputDone;
		markJobExited(job, code);
	}
}

async function finishTerminatedOutput(child: ChildProcess, outputDone: Promise<void>) {
	let timer: NodeJS.Timeout | undefined;
	const completed = await Promise.race([
		outputDone.then(() => true),
		new Promise<false>((resolveWait) => {
			timer = setTimeout(() => resolveWait(false), EXIT_STDIO_GRACE_MS);
		}),
	]);
	if (timer) clearTimeout(timer);
	if (completed) return;
	child.stdout?.destroy();
	child.stderr?.destroy();
	await outputDone;
}

async function stopJob(job: JobRecord) {
	if (job.status === "exited") {
		await job.outputDone;
		return;
	}
	if (!(await terminateProcessTree(job.child))) {
		throw new Error(`Could not stop the process tree for job '${job.name}' (pid ${job.pid}).`);
	}
	await finishTerminatedOutput(job.child, job.outputDone);
	markJobExited(job);
}

export default function powershellExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		if (!IS_WINDOWS) return;

		powershellAvailabilityPromise ??= probePowerShell();
		if (!(await powershellAvailabilityPromise)) {
			const activeTools = new Set(pi.getActiveTools());
			for (const tool of pi.getAllTools()) {
				if (tool.name === "powershell" || tool.name.startsWith("pwsh-")) activeTools.delete(tool.name);
			}
			pi.setActiveTools(Array.from(activeTools));
			ctx.ui.notify(
				`PowerShell 7 is unavailable at '${DEFAULT_SHELL}'. PowerShell tools were disabled and Bash was left unchanged. Install PowerShell 7 or set POWERSHELL_BIN, then reload Pi.`,
				"warning",
			);
			return;
		}

		const activeTools = new Set(pi.getActiveTools());
		const powershellRegistered = pi.getAllTools().some((tool) => tool.name === "powershell");
		if (activeTools.has("bash") && powershellRegistered) {
			activeTools.delete("bash");
			activeTools.add("powershell");
			pi.setActiveTools(Array.from(activeTools));
			ctx.ui.notify("Windows detected: disabled bash and enabled powershell by default.", "info");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!IS_WINDOWS) return;
		powershellAvailabilityPromise ??= probePowerShell();
		if (!(await powershellAvailabilityPromise)) return;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nPlatform note: you are running on Windows. Prefer the powershell tool over bash for shell commands unless the user explicitly requests bash.",
		};
	});

	pi.on("user_bash", async () => {
		if (!IS_WINDOWS) return;
		powershellAvailabilityPromise ??= probePowerShell();
		if (!(await powershellAvailabilityPromise)) return;
		return { operations: powershellOperations };
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		await Promise.allSettled(Array.from(startingJobOperations));
		const errors: Error[] = [];
		await Promise.all(
			Array.from(jobs.values(), async (job) => {
				try {
					await stopJob(job);
					await removeJobFiles(job);
					jobs.delete(job.name);
				} catch (error) {
					errors.push(new Error(`Failed to clean up PowerShell job '${job.name}' during shutdown.`, { cause: error }));
				} finally {
					job.trackingStopped = true;
				}
			}),
		);
		if (jobs.size === 0) {
			try {
				await removeJobsDir();
			} catch (error) {
				errors.push(new Error("Failed to remove the PowerShell job log directory during shutdown.", { cause: error }));
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "PowerShell job cleanup failed during shutdown.");
	});

	const bashDefinition = createBashToolDefinition(process.cwd(), { operations: powershellOperations });
	pi.registerTool({
		...bashDefinition,
		name: "powershell",
		label: "PowerShell",
		description:
			`Run PowerShell commands via pwsh in the current working directory. PowerShell input and output are configured for BOM-less UTF-8; stdout and stderr are decoded independently. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, with full output saved to a temp file when truncated. Optionally provide a timeout in seconds. Invoke batch files explicitly with cmd.exe /c when cmd syntax is required.`,
		promptSnippet: "Execute PowerShell commands with pwsh",
		promptGuidelines: [
			"Use powershell instead of bash when the user explicitly asks for PowerShell or when Windows-specific commands are needed.",
			"Prefer powershell for PowerShell syntax such as Get-ChildItem, Select-String, pipelines, or .ps1 scripts.",
			"PowerShell 7 text cmdlets default to BOM-less UTF-8. Pass -Encoding explicitly for known legacy or non-UTF-8 files, configure native programs themselves to emit UTF-8, and redirect binary output to a file rather than returning it as text.",
			"For failure-sensitive automation, set $ErrorActionPreference = 'Stop', consider $PSNativeCommandUseErrorActionPreference = $true, and inspect $LASTEXITCODE when appropriate; PowerShell can otherwise report success after an earlier non-terminating error.",
			"Use pwsh-start-job (not powershell with a trailing background operator such as `command &`) when you need to run a dev server, test watcher, or any long-running process. pwsh-start-job survives across tool calls; a backgrounded powershell call does not.",
			"Inspect PI_* environment variables for current model and session details.",
		],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const definition = createBashToolDefinition(ctx.cwd, { operations: powershellOperations });
			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "pwsh-start-job",
		label: "Start PowerShell Job",
		description:
			"Start a background PowerShell process that survives across tool calls in the current Pi session runtime. Use for dev servers, test watchers, or other long-running tasks. Invoke the long-running program directly; do not use Start-Process, Start-Job, or another self-detaching launcher because it can escape tracking on Windows. UTF-8 text output is normalized into a log file (merged by default) and readable via pwsh-get-job-output. Use pwsh-stop-job / pwsh-remove-job to clean up.",
		promptSnippet: "Start a detached PowerShell background process, tracked by name.",
		promptGuidelines: [
			"Use pwsh-start-job for long-running processes (dev servers, watchers) so they persist across tool calls.",
			"Invoke the long-running program directly. Do not use Start-Process, Start-Job, a trailing background operator (`command &`), or another self-detaching/backgrounding construct inside the command; on Windows an escaped process cannot be reliably tracked after the root pwsh exits. The `&` call operator remains appropriate for synchronous invocation.",
			"Check status with pwsh-get-job, read output with pwsh-get-job-output, and always clean up with pwsh-remove-job when finished.",
			"Configure native programs to emit UTF-8 text. Redirect binary data or output in another encoding to an appropriate file instead of the job log.",
			"Pass `stderr: \"null\"` or `stdout: \"null\"` to pwsh-start-job to discard a stream; pass a file path to redirect it. Omit both for a single merged log.",
			"Use the env parameter for per-job environment variables instead of embedding environment assignment syntax in the command.",
		],
		parameters: Type.Object({
			name: Type.String({
				description: "Unique portable job name (letters, numbers, dots, underscores, and hyphens; max 64 characters)",
				pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
			}),
			command: Type.String({ description: "The PowerShell command to run in the background" }),
			workingDirectory: Type.Optional(
				Type.String({ description: "Optional working directory, relative to the current project" }),
			),
			env: Type.Optional(
				Type.Record(Type.String({ pattern: "^[^=\\u0000]+$" }), Type.String(), {
					description: "Environment variables to add to or override for this job",
				}),
			),
			stdout: Type.Optional(
				Type.String({
					description: "Stdout destination: file path, or the literal \"null\" to discard. Omit to merge with stderr.",
				}),
			),
			stderr: Type.Optional(
				Type.String({
					description: "Stderr destination: file path, or the literal \"null\" to discard. Omit to merge with stdout.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (shuttingDown) throw new Error(`Cannot start job '${params.name}' while the PowerShell extension is shutting down.`);
			if (jobs.has(params.name) || startingJobs.has(params.name)) {
				throw new Error(`Job '${params.name}' already exists. Remove it first with pwsh-remove-job.`);
			}
			if (signal?.aborted) throw new Error(`Starting job '${params.name}' was aborted.`);
			let completeOperation!: () => void;
			const operation = new Promise<void>((resolveOperation) => {
				completeOperation = resolveOperation;
			});
			startingJobOperations.add(operation);
			startingJobs.add(params.name);
			const openedFds = new Set<number>();
			let child: ChildProcess | undefined;
			let record: JobRecord | undefined;
			let outputDone: Promise<void> | undefined;
			let pendingOutputError: Error | null = null;
			let ownedLogPaths: string[] = [];
			const setOutputError = (error: unknown) => {
				const normalized = error instanceof Error ? error : new Error(String(error));
				pendingOutputError ??= normalized;
				if (record) record.outputError ??= normalized;
			};
			const closeOpenedFds = () => {
				for (const fd of openedFds) {
					try {
						closeSync(fd);
					} catch (error) {
						setOutputError(error);
					}
				}
				openedFds.clear();
			};
			try {
				const cwd = resolveWorkingDirectory(ctx.cwd, params.workingDirectory);
				const jobsDir = await getJobsDir();
				if (shuttingDown) throw new Error(`Starting job '${params.name}' was interrupted by PowerShell extension shutdown.`);
				if (signal?.aborted) throw new Error(`Starting job '${params.name}' was aborted.`);
				const jobEnv = createPiEnvironment(ctx);
				for (const [name, value] of Object.entries(params.env ?? {})) {
					if (!name || name.includes("=") || name.includes("\0") || value.includes("\0")) {
						throw new Error(`Invalid environment variable for job '${params.name}'.`);
					}
					jobEnv[name] = value;
				}
				const bothDefault = params.stdout === undefined && params.stderr === undefined;
				const stdoutSpec = resolveJobStream(jobsDir, cwd, params.name, "stdout", params.stdout, bothDefault);
				const stderrSpec = resolveJobStream(jobsDir, cwd, params.name, "stderr", params.stderr, bothDefault);
				const mergedPath = bothDefault ? join(jobsDir, `${params.name}.log`) : null;
				let stdoutFd: number | "ignore" = "ignore";
				let stderrFd: number | "ignore" = "ignore";
				let stdoutPath: string | null = null;
				let stderrPath: string | null = null;
				const pathIsOwned = (path: string) =>
					[stdoutSpec, stderrSpec]
						.filter((spec): spec is Extract<JobStreamSpec, { kind: "file" }> => spec.kind === "file" && spec.path === path)
						.every((spec) => spec.owned);
				const openLog = (path: string, owned: boolean) => {
					const fd = openSync(path, "w", owned ? 0o600 : 0o666);
					if (owned && !IS_WINDOWS) chmodSync(path, 0o600);
					openedFds.add(fd);
					return fd;
				};

				if (mergedPath) {
					stdoutFd = openLog(mergedPath, true);
					stderrFd = stdoutFd;
					ownedLogPaths = [mergedPath];
				} else {
					if (stdoutSpec.kind === "file") {
						stdoutPath = stdoutSpec.path;
						const owned = pathIsOwned(stdoutPath);
						stdoutFd = openLog(stdoutPath, owned);
						if (owned) ownedLogPaths.push(stdoutPath);
					}
					if (stderrSpec.kind === "file") {
						stderrPath = stderrSpec.path;
						if (stderrPath === stdoutPath) {
							stderrFd = stdoutFd;
						} else {
							const owned = pathIsOwned(stderrPath);
							stderrFd = openLog(stderrPath, owned);
							if (owned) ownedLogPaths.push(stderrPath);
						}
					}
				}

				child = spawn(
					DEFAULT_SHELL,
					["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", wrapCommand(params.command)],
					{
						cwd,
						env: jobEnv,
						detached: !IS_WINDOWS,
						stdio: ["ignore", stdoutFd === "ignore" ? "ignore" : "pipe", stderrFd === "ignore" ? "ignore" : "pipe"],
						windowsHide: true,
					},
				);
				const capture = (stream: Readable | null, fd: number | "ignore") => {
					if (stream === null || fd === "ignore") return Promise.resolve();
					return forwardUtf8Stream(stream, (data) => {
						if (pendingOutputError) return;
						try {
							writeAll(fd, data);
						} catch (error) {
							setOutputError(error);
						}
					}).catch(setOutputError);
				};
				outputDone = Promise.all([capture(child.stdout, stdoutFd), capture(child.stderr, stderrFd)])
					.then(() => undefined)
					.finally(closeOpenedFds);
				if (child.pid) {
					record = {
						name: params.name,
						pid: child.pid,
						command: params.command,
						cwd,
						startedAt: Date.now(),
						endedAt: null,
						exitCode: null,
						mergedPath,
						stdoutPath,
						stderrPath,
						ownedLogPaths,
						status: "running",
						child,
						outputDone,
						outputError: pendingOutputError,
						trackingStopped: false,
					};
					jobs.set(params.name, record);
					child.on("close", (code) => void trackProcessGroupExit(record!, code));
					child.on("error", () => void record!.outputDone.then(() => markJobExited(record!)));
				}
				await new Promise<void>((resolveSpawn, rejectSpawn) => {
					const onSpawn = () => {
						child!.removeListener("error", onError);
						resolveSpawn();
					};
					const onError = (error: Error) => {
						child!.removeListener("spawn", onSpawn);
						rejectSpawn(error);
					};
					child!.once("spawn", onSpawn);
					child!.once("error", onError);
				});
				if (!child.pid) throw new Error(`Failed to spawn background process for job '${params.name}'.`);
				if (!record) throw new Error(`Failed to track background process for job '${params.name}'.`);
				if (shuttingDown || signal?.aborted) {
					await stopJob(record);
					throw new Error(
						shuttingDown
							? `Starting job '${params.name}' was interrupted by PowerShell extension shutdown.`
							: `Starting job '${params.name}' was aborted.`,
					);
				}

				child.unref();

				return {
					content: [{ type: "text", text: `Started job '${params.name}' (pid ${child.pid}).\n\n${summarizeJob(record)}` }],
					details: {
						name: params.name,
						pid: child.pid,
						cwd,
						mergedPath,
						stdoutPath,
						stderrPath,
					},
				};
			} catch (error) {
				try {
					if (record) {
						if (record.status === "running") await stopJob(record);
						else await record.outputDone;
						record.trackingStopped = true;
						await removeJobFiles(record);
						jobs.delete(record.name);
					} else {
						if (child?.pid && !childHasExited(child) && !(await terminateProcessTree(child))) {
							throw new Error(`Could not stop the untracked process for job '${params.name}'.`);
						}
						if (child && outputDone) await finishTerminatedOutput(child, outputDone);
						await Promise.allSettled(ownedLogPaths.map((path) => rm(path, { force: true })));
					}
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], `Starting job '${params.name}' failed and cleanup was incomplete.`);
				}
				throw error;
			} finally {
				if (!outputDone) closeOpenedFds();
				startingJobs.delete(params.name);
				completeOperation();
				startingJobOperations.delete(operation);
			}
		},
	});

	pi.registerTool({
		name: "pwsh-get-job",
		label: "Get PowerShell Job",
		description: "Get status of a background PowerShell job by name, or list all jobs when no name is given.",
		promptSnippet: "Get status for a pwsh background job, or list all jobs.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Job name. Omit to list all jobs." })),
		}),
		async execute(_toolCallId, params) {
			const listing = Array.from(jobs.values()).map((j) => ({
				name: j.name,
				status: j.status,
				pid: j.pid,
				exitCode: j.exitCode,
			}));
			if (!params.name) {
				const text =
					jobs.size === 0
						? "No active jobs."
						: `Jobs (${jobs.size}):\n${Array.from(jobs.values())
								.map((j) => `- ${j.name} [${j.status}] pid=${j.pid} exit=${j.exitCode ?? "-"} cmd=${j.command}`)
								.join("\n")}`;
				return {
					content: [{ type: "text", text }],
					details: { jobs: listing, job: null as JobSummary | null },
				};
			}
			const job = jobs.get(params.name);
			if (!job) throw new Error(`No job named '${params.name}'.`);
			return {
				content: [{ type: "text", text: summarizeJob(job) }],
				details: {
					jobs: listing,
					job: {
						name: job.name,
						status: job.status,
						pid: job.pid,
						exitCode: job.exitCode,
						startedAt: job.startedAt,
						endedAt: job.endedAt,
						mergedPath: job.mergedPath,
						stdoutPath: job.stdoutPath,
						stderrPath: job.stderrPath,
					},
				},
			};
		},
	});

	pi.registerTool({
		name: "pwsh-stop-job",
		label: "Stop PowerShell Job",
		description:
			"Stop a background PowerShell process tree. Uses taskkill /T /F on Windows while the root pwsh is alive; self-detached Windows descendants may escape tracking. On macOS and Linux it sends SIGTERM, then SIGKILL after 3 seconds if the process group is still alive.",
		promptSnippet: "Stop a running pwsh background job.",
		parameters: Type.Object({
			name: Type.String({ description: "Job name to stop" }),
		}),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.name);
			if (!job) throw new Error(`No job named '${params.name}'.`);
			const alreadyExited = job.status === "exited";
			if (!alreadyExited) await stopJob(job);
			const text = alreadyExited
				? `Job '${params.name}' already exited (code ${job.exitCode ?? "-"}).`
				: `Stopped job '${params.name}'.\n\n${summarizeJob(job)}`;
			return {
				content: [{ type: "text", text }],
				details: { name: params.name, status: job.status, exitCode: job.exitCode, alreadyExited },
			};
		},
	});

	pi.registerTool({
		name: "pwsh-remove-job",
		label: "Remove PowerShell Job",
		description: "Remove a background PowerShell job from tracking. Stops the job first if still running, then deletes log files created by pwsh-start-job's default log directory.",
		promptSnippet: "Remove a pwsh background job and clean up its logs.",
		parameters: Type.Object({
			name: Type.String({ description: "Job name to remove" }),
		}),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.name);
			if (!job) throw new Error(`No job named '${params.name}'.`);
			if (job.status === "running") await stopJob(job);
			await removeJobFiles(job);
			jobs.delete(params.name);
			return {
				content: [{ type: "text", text: `Removed job '${params.name}' (exit code ${job.exitCode ?? "-"}).` }],
				details: { name: params.name, exitCode: job.exitCode },
			};
		},
	});

	pi.registerTool({
		name: "pwsh-get-job-output",
		label: "Get PowerShell Job Output",
		description:
			"Read captured stdout/stderr for a background PowerShell job. By default, returns the tail of each log up to 2000 lines / 50KB. Pass cursor={} to read bounded chunks from the beginning without gaps, then pass each returned next cursor to continue. Pass full=true to include raw log paths.",
		promptSnippet: "Read logged output for a pwsh background job.",
		promptGuidelines: [
			"For noisy long-running jobs, start with cursor={} and pass the returned nextCursor to each subsequent call. Reuse the last cursor later to read output appended after hasMore=no.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Job name" }),
			full: Type.Optional(
				Type.Boolean({ description: "When true, also include the full log file path(s) so you can read them directly." }),
			),
			cursor: Type.Optional(
				Type.Object({
					merged: Type.Optional(Type.Integer({ minimum: 0, description: "Next byte offset for the merged log" })),
					stdout: Type.Optional(Type.Integer({ minimum: 0, description: "Next byte offset for stdout" })),
					stderr: Type.Optional(Type.Integer({ minimum: 0, description: "Next byte offset for stderr" })),
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.name);
			if (!job) throw new Error(`No job named '${params.name}'.`);
			const incremental = params.cursor !== undefined;
			const sections: string[] = [summarizeJob(job, params.full === true)];
			const nextCursor: Partial<Record<"merged" | "stdout" | "stderr", number>> = {};
			const hasMore: Partial<Record<"merged" | "stdout" | "stderr", boolean>> = {};
			const appendOutput = async (slot: "merged" | "stdout" | "stderr", label: string, path: string) => {
				if (incremental) {
					const trunc = await readJobFileFromCursor(
						path,
						params.cursor?.[slot] ?? 0,
						DEFAULT_MAX_LINES,
						DEFAULT_MAX_BYTES,
					);
					if (trunc === null) {
						nextCursor[slot] = params.cursor?.[slot] ?? 0;
						hasMore[slot] = false;
						sections.push(`(${label} log not yet created${params.full ? ` at ${path}` : ""})`);
						return;
					}
					nextCursor[slot] = trunc.nextOffset;
					hasMore[slot] = trunc.hasMore;
					sections.push(
						`${label} (cursor=${trunc.startOffset}->${trunc.nextOffset}, lines=${trunc.outputLines}, bytes=${trunc.outputBytes}/${trunc.totalBytes}, hasMore=${formatBool(trunc.hasMore)}):\n${trunc.content || "(no new output)"}`,
					);
					return;
				}

				const trunc = await readJobFile(path, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
				sections.push(
					trunc === null
						? `(${label} log not yet created${params.full ? ` at ${path}` : ""})`
						: `${label} (truncated=${formatBool(trunc.truncated)}, lines=${trunc.outputLines}/${trunc.totalLinesKnown ? trunc.totalLines : "?"}, bytes=${trunc.outputBytes}/${trunc.totalBytes}):\n${trunc.content.trimEnd()}`,
				);
			};

			if (job.mergedPath) await appendOutput("merged", "merged output", job.mergedPath);
			if (job.stdoutPath) await appendOutput("stdout", "stdout", job.stdoutPath);
			if (job.stderrPath) await appendOutput("stderr", "stderr", job.stderrPath);
			if (!job.mergedPath && !job.stdoutPath && !job.stderrPath) {
				sections.push("(no log files — both streams were discarded)");
			}
			if (incremental) sections.push(`Next cursor: ${JSON.stringify(nextCursor)}`);

			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: {
					name: job.name,
					status: job.status,
					exitCode: job.exitCode,
					mergedPath: params.full === true ? job.mergedPath : undefined,
					stdoutPath: params.full === true ? job.stdoutPath : undefined,
					stderrPath: params.full === true ? job.stderrPath : undefined,
					nextCursor: incremental ? nextCursor : undefined,
					hasMore: incremental ? hasMore : undefined,
				},
			};
		},
	});
}
