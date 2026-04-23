// Job tool API shape (pwsh-start-job / get / stop / remove / get-output, the
// "null" discard sentinel, merged-by-default logging, UTF-8 prefix, .cmd/.bat
// retry) is adapted from @marcfargas/pi-powershell (MIT). Implementation is
// Node-native (child_process.spawn with detached + fd redirection) rather than
// PowerShell's Start-Process.
//   https://github.com/marcfargas/pi-powershell
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	isToolCallEventType,
	truncateTail,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_SHELL = process.env.POWERSHELL_BIN || "pwsh";
const IS_WINDOWS = process.platform === "win32";
const STREAM_THROTTLE_MS = 120;

const UTF8_PREFIX =
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
	"$OutputEncoding = [System.Text.Encoding]::UTF8\n";

const BATCH_FILE_RE = /\.(cmd|bat)(?=\s|$|'|")/i;
const STARTS_WITH_CMD_RE = /^\s*"?cmd(?:\.exe)?"?(?:\s|$)/i;

const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let jobsDirPromise: Promise<string> | null = null;

async function getJobsDir(): Promise<string> {
	if (!jobsDirPromise) {
		const dir = join(tmpdir(), `pi-powershell-jobs-${INSTANCE_ID}`);
		jobsDirPromise = mkdir(dir, { recursive: true }).then(() => dir);
	}
	return jobsDirPromise;
}

function resolveWorkingDirectory(cwd: string, inputCwd?: string): string {
	if (!inputCwd) return cwd;
	const trimmed = inputCwd.startsWith("@") ? inputCwd.slice(1) : inputCwd;
	return resolve(cwd, trimmed);
}

function wrapCommand(command: string): string {
	return UTF8_PREFIX + command;
}

function shouldRetryAsBatch(command: string, exitCode: number): boolean {
	if (!IS_WINDOWS) return false;
	if (exitCode === 0) return false;
	if (STARTS_WITH_CMD_RE.test(command)) return false;
	return BATCH_FILE_RE.test(command);
}

async function saveFullOutput(stdout: string, stderr: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-powershell-"));
	const file = join(dir, "full-output.txt");
	await writeFile(file, [`# stdout`, stdout, ``, `# stderr`, stderr].join("\n"), "utf8");
	return file;
}

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
}

type ChunkSink = (combined: string) => void;

async function runProcess(
	bin: string,
	args: string[],
	cwd: string,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
	onChunk: ChunkSink | undefined,
): Promise<RunResult> {
	const child = spawn(bin, args, {
		cwd,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	let combined = "";
	let timedOut = false;

	let lastFlush = 0;
	let pendingFlush: NodeJS.Timeout | undefined;
	const flushChunk = () => {
		if (!onChunk) return;
		lastFlush = Date.now();
		onChunk(combined);
	};
	const scheduleFlush = () => {
		if (!onChunk) return;
		const delta = Date.now() - lastFlush;
		if (delta >= STREAM_THROTTLE_MS) {
			flushChunk();
			return;
		}
		if (pendingFlush) return;
		pendingFlush = setTimeout(() => {
			pendingFlush = undefined;
			flushChunk();
		}, STREAM_THROTTLE_MS - delta);
	};

	child.stdout.on("data", (chunk: Buffer) => {
		const s = chunk.toString("utf8");
		stdout += s;
		combined += s;
		scheduleFlush();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		const s = chunk.toString("utf8");
		stderr += s;
		combined += s;
		scheduleFlush();
	});

	const abortHandler = () => {
		child.kill("SIGTERM");
	};
	if (signal) {
		if (signal.aborted) abortHandler();
		signal.addEventListener("abort", abortHandler, { once: true });
	}

	let timeoutId: NodeJS.Timeout | undefined;
	if (typeof timeoutSeconds === "number" && timeoutSeconds > 0) {
		timeoutId = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutSeconds * 1000);
	}

	try {
		const exitCode = await new Promise<number | null>((resolveProm, reject) => {
			child.on("error", reject);
			child.on("close", resolveProm);
		});
		if (pendingFlush) {
			clearTimeout(pendingFlush);
			pendingFlush = undefined;
		}
		if (onChunk) onChunk(combined);
		return { stdout, stderr, exitCode: exitCode ?? -1, timedOut };
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		if (signal) signal.removeEventListener("abort", abortHandler);
	}
}

function runPowerShell(
	command: string,
	cwd: string,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
	onChunk?: ChunkSink,
): Promise<RunResult> {
	const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", wrapCommand(command)];
	return runProcess(DEFAULT_SHELL, args, cwd, timeoutSeconds, signal, onChunk);
}

function runCmd(
	command: string,
	cwd: string,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
	onChunk?: ChunkSink,
): Promise<RunResult> {
	return runProcess("cmd.exe", ["/c", command], cwd, timeoutSeconds, signal, onChunk);
}

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
	status: "running" | "exited";
	child: ChildProcess;
}

const jobs = new Map<string, JobRecord>();

type JobStreamSpec = { kind: "merged" } | { kind: "discard" } | { kind: "file"; path: string };

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
		return { kind: "file", path: isAbsolute(raw) ? raw : resolve(cwd, raw) };
	}
	return { kind: "file", path: join(jobsDir, `${name}-${slot}.log`) };
}

async function readJobFile(path: string, maxLines: number, maxBytes: number) {
	try {
		const content = await readFile(path, "utf8");
		return truncateTail(content, { maxLines, maxBytes });
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw err;
	}
}

async function removeJobFiles(job: JobRecord) {
	const paths = [job.mergedPath, job.stdoutPath, job.stderrPath].filter((p): p is string => !!p);
	await Promise.all(
		paths.map((p) => rm(p, { force: true }).catch(() => undefined)),
	);
}

function formatBool(v: boolean | undefined): string {
	return v ? "yes" : "no";
}

function summarizeJob(job: JobRecord): string {
	const runtimeMs = (job.endedAt ?? Date.now()) - job.startedAt;
	return [
		`Name: ${job.name}`,
		`Status: ${job.status}`,
		`PID: ${job.pid}`,
		`Exit code: ${job.exitCode ?? "n/a"}`,
		`Runtime: ${(runtimeMs / 1000).toFixed(1)}s`,
		`Command: ${job.command}`,
		`Cwd: ${job.cwd}`,
		job.mergedPath ? `Merged log: ${job.mergedPath}` : undefined,
		job.stdoutPath ? `Stdout log: ${job.stdoutPath}` : undefined,
		job.stderrPath ? `Stderr log: ${job.stderrPath}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

export default function powershellExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!IS_WINDOWS) return;

		const activeTools = new Set(pi.getActiveTools());
		if (activeTools.has("bash")) {
			activeTools.delete("bash");
			activeTools.add("powershell");
			pi.setActiveTools(Array.from(activeTools));
			ctx.ui.notify("Windows detected: disabled bash and enabled powershell by default.", "info");
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!IS_WINDOWS) return;
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nPlatform note: you are running on Windows. Prefer the powershell tool over bash for shell commands unless the user explicitly requests bash.",
		};
	});

	pi.on("tool_call", async (event) => {
		if (!IS_WINDOWS) return;
		if (isToolCallEventType("bash", event)) {
			return {
				block: true,
				reason:
					"bash is disabled on Windows by the PowerShell extension. Use the powershell tool unless the user explicitly requests bash.",
			};
		}
	});

	pi.registerTool({
		name: "powershell",
		label: "PowerShell",
		description:
			"Run PowerShell commands via pwsh. Useful for Windows-style shell commands, PowerShell pipelines, .ps1 scripts, registry or service inspection, and cross-platform pwsh workflows. Output is forced to UTF-8. On Windows, failed .cmd/.bat invocations retry automatically via cmd.exe /c.",
		promptSnippet: "Run PowerShell commands with pwsh and return stdout/stderr plus exit status.",
		promptGuidelines: [
			"Use powershell instead of bash when the user explicitly asks for PowerShell or when Windows-specific commands are needed.",
			"Prefer powershell for PowerShell syntax such as Get-ChildItem, Select-String, pipelines, or .ps1 scripts.",
			"Use pwsh-start-job (not powershell with `&` backgrounding) when you need to run a dev server, test watcher, or any long-running process. pwsh-start-job survives across tool calls; a backgrounded powershell call does not.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The PowerShell command to run" }),
			cwd: Type.Optional(Type.String({ description: "Optional working directory, relative to the current project" })),
			timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = resolveWorkingDirectory(ctx.cwd, params.cwd);
			const onChunk: ChunkSink | undefined = onUpdate
				? (combined) => {
						const preview = truncateTail(combined, {
							maxLines: DEFAULT_MAX_LINES,
							maxBytes: DEFAULT_MAX_BYTES,
						});
						onUpdate({
							content: [{ type: "text", text: preview.content }],
							details: {
								command: params.command,
								cwd,
								streaming: true,
							},
						});
				  }
				: undefined;

			let result = await runPowerShell(params.command, cwd, params.timeout, signal, onChunk);
			let retriedViaCmd = false;
			if (shouldRetryAsBatch(params.command, result.exitCode) && !result.timedOut) {
				retriedViaCmd = true;
				result = await runCmd(params.command, cwd, params.timeout, signal, onChunk);
			}

			const fullCombined = `${result.stdout}${result.stderr}`;
			const stdoutTrunc = truncateTail(result.stdout, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const stderrTrunc = truncateTail(result.stderr, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const truncated = stdoutTrunc.truncated || stderrTrunc.truncated;
			const fullOutputPath = truncated ? await saveFullOutput(result.stdout, result.stderr) : undefined;

			const summary = [
				`Command: ${params.command}`,
				`Shell: ${retriedViaCmd ? "cmd.exe /c (retry after pwsh failure)" : DEFAULT_SHELL}`,
				`Working directory: ${cwd}`,
				`Exit code: ${result.exitCode}`,
				result.timedOut ? `Timed out: yes` : undefined,
				truncated && fullOutputPath ? `Full output saved to: ${fullOutputPath}` : undefined,
			].filter(Boolean);

			const sections = [summary.join("\n")];
			if (stdoutTrunc.content.trim()) sections.push(`stdout:\n${stdoutTrunc.content.trimEnd()}`);
			if (stderrTrunc.content.trim()) sections.push(`stderr:\n${stderrTrunc.content.trimEnd()}`);
			if (!stdoutTrunc.content.trim() && !stderrTrunc.content.trim()) sections.push("(no output)");

			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: {
					command: params.command,
					cwd,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					truncated,
					fullOutputPath,
					retriedViaCmd,
					stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
					stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
					combinedBytes: Buffer.byteLength(fullCombined, "utf8"),
				},
				isError: result.exitCode !== 0 || result.timedOut,
			};
		},
	});

	pi.registerTool({
		name: "pwsh-start-job",
		label: "Start PowerShell Job",
		description:
			"Start a background PowerShell process. The process survives across tool calls as a detached OS process. Use for dev servers, test watchers, or any long-running task. Output is captured to a log file (merged by default) and readable via pwsh-get-job-output. Use pwsh-stop-job / pwsh-remove-job to clean up.",
		promptSnippet: "Start a detached PowerShell background process, tracked by name.",
		promptGuidelines: [
			"Use pwsh-start-job for long-running processes (dev servers, watchers) so they persist across tool calls.",
			"Check status with pwsh-get-job, read output with pwsh-get-job-output, and always clean up with pwsh-remove-job when finished.",
			"Pass `stderr: \"null\"` or `stdout: \"null\"` to pwsh-start-job to discard a stream; pass a file path to redirect it. Omit both for a single merged log.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Unique job name for tracking" }),
			command: Type.String({ description: "The PowerShell command to run in the background" }),
			workingDirectory: Type.Optional(
				Type.String({ description: "Optional working directory, relative to the current project" }),
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (jobs.has(params.name)) {
				throw new Error(`Job '${params.name}' already exists. Remove it first with pwsh-remove-job.`);
			}
			const cwd = resolveWorkingDirectory(ctx.cwd, params.workingDirectory);
			const jobsDir = await getJobsDir();
			const bothDefault = params.stdout === undefined && params.stderr === undefined;
			const stdoutSpec = resolveJobStream(jobsDir, cwd, params.name, "stdout", params.stdout, bothDefault);
			const stderrSpec = resolveJobStream(jobsDir, cwd, params.name, "stderr", params.stderr, bothDefault);

			const mergedPath = bothDefault ? join(jobsDir, `${params.name}.log`) : null;

			let stdoutFd: number | "ignore";
			let stderrFd: number | "ignore";
			let stdoutPath: string | null = null;
			let stderrPath: string | null = null;

			if (mergedPath) {
				const fd = openSync(mergedPath, "w");
				stdoutFd = fd;
				stderrFd = fd;
			} else {
				if (stdoutSpec.kind === "discard") {
					stdoutFd = "ignore";
				} else if (stdoutSpec.kind === "file") {
					stdoutPath = stdoutSpec.path;
					stdoutFd = openSync(stdoutSpec.path, "w");
				} else {
					stdoutFd = "ignore";
				}
				if (stderrSpec.kind === "discard") {
					stderrFd = "ignore";
				} else if (stderrSpec.kind === "file") {
					stderrPath = stderrSpec.path;
					stderrFd = openSync(stderrSpec.path, "w");
				} else {
					stderrFd = "ignore";
				}
			}

			const child = spawn(
				DEFAULT_SHELL,
				["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", wrapCommand(params.command)],
				{
					cwd,
					env: process.env,
					detached: true,
					stdio: ["ignore", stdoutFd, stderrFd],
				},
			);

			if (typeof stdoutFd === "number") closeSync(stdoutFd);
			if (typeof stderrFd === "number" && stderrFd !== stdoutFd) closeSync(stderrFd);

			if (!child.pid) {
				throw new Error(`Failed to spawn background process for job '${params.name}'.`);
			}
			child.unref();

			const record: JobRecord = {
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
				status: "running",
				child,
			};
			jobs.set(params.name, record);

			child.on("exit", (code) => {
				record.status = "exited";
				record.exitCode = code ?? -1;
				record.endedAt = Date.now();
			});

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
		description: "Stop a running background PowerShell job. Sends SIGTERM, then SIGKILL after 3 seconds if still alive.",
		promptSnippet: "Stop a running pwsh background job.",
		parameters: Type.Object({
			name: Type.String({ description: "Job name to stop" }),
		}),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.name);
			if (!job) throw new Error(`No job named '${params.name}'.`);
			const alreadyExited = job.status === "exited";
			if (!alreadyExited) {
				try {
					job.child.kill("SIGTERM");
				} catch {
					// already dead; ignore
				}
				await new Promise<void>((resolveWait) => {
					const timer = setTimeout(() => {
						try {
							job.child.kill("SIGKILL");
						} catch {
							// ignore
						}
						resolveWait();
					}, 3000);
					job.child.once("exit", () => {
						clearTimeout(timer);
						resolveWait();
					});
				});
			}
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
			if (job.status === "running") {
				try {
					job.child.kill("SIGTERM");
				} catch {
					// ignore
				}
				await new Promise<void>((resolveWait) => {
					const timer = setTimeout(() => {
						try {
							job.child.kill("SIGKILL");
						} catch {
							// ignore
						}
						resolveWait();
					}, 3000);
					job.child.once("exit", () => {
						clearTimeout(timer);
						resolveWait();
					});
				});
			}
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
			"Read captured stdout/stderr for a background PowerShell job. Returns the tail of each log file up to 2000 lines / 50KB per stream. Pass full=true to return the raw path to the untruncated log.",
		promptSnippet: "Read logged output for a pwsh background job.",
		parameters: Type.Object({
			name: Type.String({ description: "Job name" }),
			full: Type.Optional(
				Type.Boolean({ description: "When true, also include the full log file path(s) so you can read them directly." }),
			),
		}),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.name);
			if (!job) throw new Error(`No job named '${params.name}'.`);
			const sections: string[] = [summarizeJob(job)];

			if (job.mergedPath) {
				const trunc = await readJobFile(job.mergedPath, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
				if (trunc === null) {
					sections.push(`(merged log not yet created at ${job.mergedPath})`);
				} else {
					sections.push(
						`merged output (truncated=${formatBool(trunc.truncated)}, lines=${trunc.outputLines}/${trunc.totalLines}):\n${trunc.content.trimEnd()}`,
					);
				}
			}
			if (job.stdoutPath) {
				const trunc = await readJobFile(job.stdoutPath, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
				sections.push(
					trunc === null
						? `(stdout log not yet created at ${job.stdoutPath})`
						: `stdout (truncated=${formatBool(trunc.truncated)}, lines=${trunc.outputLines}/${trunc.totalLines}):\n${trunc.content.trimEnd()}`,
				);
			}
			if (job.stderrPath) {
				const trunc = await readJobFile(job.stderrPath, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
				sections.push(
					trunc === null
						? `(stderr log not yet created at ${job.stderrPath})`
						: `stderr (truncated=${formatBool(trunc.truncated)}, lines=${trunc.outputLines}/${trunc.totalLines}):\n${trunc.content.trimEnd()}`,
				);
			}
			if (!job.mergedPath && !job.stdoutPath && !job.stderrPath) {
				sections.push("(no log files — both streams were discarded)");
			}

			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: {
					name: job.name,
					status: job.status,
					exitCode: job.exitCode,
					mergedPath: params.full ? job.mergedPath : undefined,
					stdoutPath: params.full ? job.stdoutPath : undefined,
					stderrPath: params.full ? job.stderrPath : undefined,
				},
			};
		},
	});
}
