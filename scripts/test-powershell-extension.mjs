#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
initTheme();
const shell = process.env.POWERSHELL_BIN || "pwsh";
if (process.argv.includes("--verify-unavailable-windows")) {
	await verifyUnavailableWindowsFallback();
	process.exit(0);
}
const version = spawnSync(shell, ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
	encoding: "utf8",
});
if (version.error || version.status !== 0) {
	throw new Error(`PowerShell is unavailable at '${shell}'. Run: npm run setup:powershell`);
}

const tools = new Map();
const handlers = new Map();
const commands = new Map();
const messageRenderers = new Map();
const notifications = [];
const sentMessages = [];
const statusUpdates = [];
const editorViews = [];
const selectResponses = [];
const confirmResponses = [];
let activeToolOverride = null;
const pi = {
	on(event, handler) {
		handlers.set(event, handler);
	},
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
	registerCommand(name, command) {
		commands.set(name, command);
	},
	registerMessageRenderer(customType, renderer) {
		messageRenderers.set(customType, renderer);
	},
	sendMessage(message, options) {
		sentMessages.push({ message, options });
	},
	getActiveTools() {
		return activeToolOverride ?? ["bash", ...tools.keys()];
	},
	getAllTools() {
		return Array.from(tools.values(), ({ name }) => ({ name }));
	},
	setActiveTools(names) {
		activeToolOverride = [...names];
	},
};

const jiti = createJiti(import.meta.url);
const { default: extension, probePowerShell } = await jiti.import(join(repoRoot, "extensions", "powershell.ts"));
extension(pi);

const ctx = {
	cwd: repoRoot,
	mode: "tui",
	hasUI: true,
	model: { provider: "openai", id: "powershell-test-model" },
	thinkingLevel: "medium",
	sessionManager: {
		getSessionId: () => "powershell-test-session",
		getSessionFile: () => join(repoRoot, "powershell-test-session.jsonl"),
	},
	ui: {
		async select(title, options) {
			const response = selectResponses.shift();
			return typeof response === "function" ? response(title, options) : response;
		},
		async confirm(title, message) {
			const response = confirmResponses.shift();
			return typeof response === "function" ? response(title, message) : (response ?? false);
		},
		async editor(title, prefill) {
			editorViews.push({ title, prefill });
			return undefined;
		},
		notify(message, level) {
			notifications.push({ message, level });
		},
		setStatus(key, text) {
			statusUpdates.push({ key, text });
		},
	},
};

const testTheme = {
	fg(_color, text) {
		return text;
	},
	bg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
};

function createRenderContext(args, overrides = {}) {
	return {
		args,
		toolCallId: "renderer-test",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: repoRoot,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

const foreground = requiredTool("powershell");
const startedJobs = new Set();
const scratchDir = await mkdtemp(join(tmpdir(), "pi-powershell-test-"));
let fullOutputPath;

try {
	assert(commands.has("pwsh-jobs"), "interactive PowerShell job manager command was not registered");
	assert(messageRenderers.has("powershell-job-failed"), "PowerShell job failure renderer was not registered");
	const maxLogSchema = requiredTool("pwsh-start-job").parameters.properties.maxLogBytes;
	assert(
		maxLogSchema.minimum === 1 &&
			maxLogSchema.maximum === 1024 * 1024 * 1024 &&
			maxLogSchema.type === "integer" &&
			maxLogSchema.description.includes("default 10 MiB"),
		"maxLogBytes did not advertise its 10 MiB default and integer 1..1 GiB bounds",
	);
	assert(
		["pwsh-start-job", "pwsh-get-job", "pwsh-stop-job", "pwsh-remove-job", "pwsh-get-job-output"].every(
			(name) => requiredTool(name).renderCall && requiredTool(name).renderResult,
		),
		"one or more PowerShell job tools did not register semantic renderers",
	);
	const foregroundRenderArgs = { command: "Write-Output renderer-check" };
	const foregroundCall = foreground.renderCall(
		foregroundRenderArgs,
		testTheme,
		createRenderContext(foregroundRenderArgs),
	);
	const foregroundCallText = foregroundCall.render(100).join("\n");
	assert(foregroundCallText.includes("PS>"), "foreground rendering did not use Pi's PowerShell prompt");
	assert(!foregroundCallText.includes("$ Write-Output"), "foreground rendering still used Pi's Bash prompt");
	const startRenderArgs = { name: "renderer-job", command: "Write-Output renderer-check" };
	const startCallText = requiredTool("pwsh-start-job")
		.renderCall(startRenderArgs, testTheme, createRenderContext(startRenderArgs))
		.render(100)
		.join("\n");
	assert(
		startCallText.includes("renderer-job") && startCallText.includes("PS> Write-Output renderer-check"),
		"background start renderer omitted the job name or PowerShell command",
	);

	assert(await probePowerShell(shell), "PowerShell availability probe rejected the configured executable");
	assert(
		!(await probePowerShell(join(scratchDir, "definitely-missing-pwsh"))),
		"PowerShell availability probe accepted a missing executable",
	);
	await handlers.get("session_start")({}, ctx);
	if (process.platform === "win32") {
		assert(activeToolOverride?.includes("powershell"), "session start did not activate powershell on Windows");
		assert(!activeToolOverride?.includes("bash"), "session start did not deactivate bash on Windows");
		assert(
			notifications.some(({ message, level }) => level === "info" && message.includes("enabled powershell")),
			"session start did not report PowerShell activation",
		);
		const beforeAgentResult = await handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, ctx);
		assert(beforeAgentResult?.systemPrompt.includes("Prefer the powershell tool"), "Windows system prompt guidance was missing");
		const unavailable = spawnSync(process.execPath, [scriptPath, "--verify-unavailable-windows"], {
			cwd: repoRoot,
			env: { ...process.env, POWERSHELL_BIN: join(scratchDir, "definitely-missing-pwsh-child") },
			encoding: "utf8",
			timeout: 15_000,
		});
		assert(
			unavailable.status === 0,
			`PowerShell-unavailable fallback failed: ${unavailable.error?.message ?? unavailable.stderr ?? unavailable.stdout}`,
		);
	} else {
		assert(activeToolOverride === null, "session start changed active tools outside Windows");
	}

	const userBashHandler = handlers.get("user_bash");
	assert(userBashHandler, "extension did not register the user_bash handler");
	const userBashResult = await userBashHandler(
		{ type: "user_bash", command: "Write-Output user-bash-powershell", excludeFromContext: false, cwd: repoRoot },
		ctx,
	);
	if (process.platform === "win32") {
		assert(userBashResult?.operations, "user ! commands were not routed to PowerShell on Windows");
		let userBashOutput = "";
		const routedResult = await userBashResult.operations.exec("Write-Output user-bash-powershell", repoRoot, {
			onData: (data) => {
				userBashOutput += data.toString("utf8");
			},
			env: process.env,
		});
		assert(routedResult.exitCode === 0, "PowerShell execution for a user ! command failed");
		assert(userBashOutput.includes("user-bash-powershell"), "user ! command did not produce PowerShell output");
	} else {
		assert(userBashResult === undefined, "user ! commands should retain Pi's default shell outside Windows");
	}

	let streamingUpdates = 0;
	const success = await foreground.execute(
		"success",
		{
			command:
				'Write-Output "$env:PI_SESSION_ID|$env:PI_SESSION_FILE|$env:PI_PROVIDER|$env:PI_MODEL|$env:PI_REASONING_LEVEL"; [Console]::Error.WriteLine("warning-stream")',
		},
		undefined,
		() => streamingUpdates++,
		ctx,
	);
	const successText = success.content[0].text;
	assert(
		successText.includes(
			`powershell-test-session|${join(repoRoot, "powershell-test-session.jsonl")}|openai|powershell-test-model|medium`,
		),
		"foreground PI environment was incomplete",
	);
	assert(successText.includes("warning-stream"), "stderr was not captured");
	assert(streamingUpdates > 0, "streaming updates were not emitted");

	const multiline = await foreground.execute(
		"multiline",
		{
			command: `$value = @'
line "double"
line 'single' 🚀
'@
Write-Output $value`,
		},
		undefined,
		undefined,
		ctx,
	);
	assert(
		multiline.content[0].text.includes('line "double"') && multiline.content[0].text.includes("line 'single' 🚀"),
		"multiline here-string or quote handling failed",
	);

	const quotedNode = process.execPath.replaceAll("'", "''");
	const encodingSettings = await foreground.execute(
		"encoding-settings",
		{
			command:
				'Write-Output "$([Console]::InputEncoding.WebName)|$([Console]::OutputEncoding.WebName)|$($OutputEncoding.WebName)"',
		},
		undefined,
		undefined,
		ctx,
	);
	assert(
		encodingSettings.content[0].text.trim() === "utf-8|utf-8|utf-8",
		`PowerShell input/output encodings were not all UTF-8: ${encodingSettings.content[0].text}`,
	);

	const nativePipeline = await foreground.execute(
		"native-pipeline",
		{
			command: `'yes-雪-🚀' | & '${quotedNode}' -e 'process.stdin.on("data", data => console.log(data.toString("hex")))'`,
		},
		undefined,
		undefined,
		ctx,
	);
	const nativePipelineHex = nativePipeline.content[0].text.trim();
	assert(!nativePipelineHex.startsWith("efbbbf"), "PowerShell added a UTF-8 BOM to native pipeline input");
	assert(
		nativePipelineHex.startsWith(Buffer.from("yes-雪-🚀", "utf8").toString("hex")),
		"PowerShell did not pass UTF-8 text through a native pipeline",
	);

	const nativeInterleaveScript =
		'const bom=Buffer.from([0xef,0xbb,0xbf]);const value=Buffer.from("🚀");process.stdout.write(bom);process.stdout.write("x".repeat(60000));process.stdout.write(value.subarray(0,2));setTimeout(()=>{process.stderr.write(Buffer.concat([bom,Buffer.from("between-雪\\n")]));setTimeout(()=>process.stdout.write(value.subarray(2)),100)},100)';
	const interleavedUpdates = [];
	const interleaved = await foreground.execute(
		"interleaved-unicode-streams",
		{ command: `& '${quotedNode}' -e '${nativeInterleaveScript}'` },
		undefined,
		(update) => {
			interleavedUpdates.push(
				update.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
			);
		},
		ctx,
	);
	const interleavedText = interleaved.content[0].text;
	assert(interleavedText.includes("🚀"), "the foreground tail lost its final interleaved Unicode character");
	assert(!interleavedText.includes("�"), "foreground interleaved Unicode produced a replacement character");
	assert(!interleavedText.includes("\uFEFF"), "foreground output retained a per-stream UTF-8 BOM");
	assert(
		interleavedUpdates.every((text) => !text.includes("�") && !text.includes("\uFEFF")),
		"a foreground streaming update exposed corrupt Unicode or a BOM",
	);
	assert(interleavedUpdates.some((text) => text.includes("between-雪")), "a foreground streaming update lost stderr Unicode");
	fullOutputPath = interleaved.details?.fullOutputPath;
	assert(interleaved.details?.truncation?.truncated && fullOutputPath, "interleaved output was not spilled for verification");
	const interleavedFullText = await readFile(fullOutputPath, "utf8");
	assert(
		interleavedFullText.includes("between-雪") && interleavedFullText.includes("🚀"),
		"the spilled foreground output lost interleaved Unicode",
	);
	assert(!interleavedFullText.includes("�"), "the spilled foreground output contained a replacement character");
	assert(!interleavedFullText.includes("\uFEFF"), "the spilled foreground output retained a per-stream UTF-8 BOM");
	await rm(fullOutputPath, { force: true });
	fullOutputPath = undefined;

	let strictError = "";
	try {
		await foreground.execute(
			"strict-error",
			{ command: "$ErrorActionPreference = 'Stop'; Get-Item '/definitely-missing-powershell-test'; Write-Output unreachable" },
			undefined,
			undefined,
			ctx,
		);
	} catch (error) {
		strictError = String(error);
	}
	assert(strictError.includes("definitely-missing-powershell-test"), "strict PowerShell error handling was not observable");

	let nonzeroError = "";
	try {
		await foreground.execute("nonzero", { command: "Write-Output before-failure; exit 7" }, undefined, undefined, ctx);
	} catch (error) {
		nonzeroError = String(error);
	}
	assert(nonzeroError.includes("before-failure") && nonzeroError.includes("code 7"), "nonzero exit handling failed");

	const timeoutStartedAt = Date.now();
	let timeoutError = "";
	try {
		await foreground.execute(
			"timeout",
			{
				command: `& '${quotedNode}' -e 'console.log("timeout-child=" + process.pid); setTimeout(() => {}, 30000)'`,
				timeout: 1,
			},
			undefined,
			undefined,
			ctx,
		);
	} catch (error) {
		timeoutError = String(error);
	}
	const timeoutMs = Date.now() - timeoutStartedAt;
	assert(timeoutError.includes("timed out") && timeoutMs < 7_000, "timeout or process-tree termination failed");
	const timeoutChildPid = Number(timeoutError.match(/timeout-child=(\d+)/)?.[1]);
	assert(Number.isInteger(timeoutChildPid), "foreground timeout did not capture its descendant process id");
	await waitForProcessExit(timeoutChildPid);

	const abortController = new AbortController();
	setTimeout(() => abortController.abort(), 1_000);
	let abortError = "";
	try {
		await foreground.execute(
			"abort",
			{ command: `& '${quotedNode}' -e 'console.log("abort-child=" + process.pid); setTimeout(() => {}, 30000)'` },
			abortController.signal,
			undefined,
			ctx,
		);
	} catch (error) {
		abortError = String(error);
	}
	assert(abortError.includes("aborted"), "abort handling failed");
	const abortChildPid = Number(abortError.match(/abort-child=(\d+)/)?.[1]);
	assert(Number.isInteger(abortChildPid), "foreground abort did not capture its descendant process id");
	await waitForProcessExit(abortChildPid);

	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot;
		const missingTaskkillAbort = new AbortController();
		let rootPid;
		let missingTaskkillError = "";
		const startedAt = Date.now();
		try {
			await foreground.execute(
				"missing-taskkill",
				{ command: 'Write-Output "fallback-root=$PID"; Start-Sleep -Seconds 30' },
				missingTaskkillAbort.signal,
				(update) => {
					const match = update.content[0]?.text?.match(/fallback-root=(\d+)/);
					if (!match || rootPid) return;
					rootPid = Number(match[1]);
					// Change lookup only after PowerShell has initialized successfully.
					process.env.SystemRoot = join(scratchDir, "missing-system-root");
					missingTaskkillAbort.abort();
				},
				ctx,
			);
		} catch (error) {
			missingTaskkillError = String(error);
		} finally {
			if (systemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = systemRoot;
		}
		assert(rootPid && Date.now() - startedAt < 10_000, "missing taskkill left foreground cancellation waiting");
		assert(missingTaskkillError.includes("Could not stop the PowerShell process tree"), "failed tree cleanup was hidden");
		await waitForProcessExit(rootPid);
	}

	const large = await foreground.execute(
		"large",
		{ command: '1..3000 | ForEach-Object { "line-$_" }' },
		undefined,
		undefined,
		ctx,
	);
	fullOutputPath = large.details?.fullOutputPath;
	assert(large.details?.truncation?.truncated, "large output was not truncated");
	assert(fullOutputPath && existsSync(fullOutputPath), "full output was not spilled to a temporary file");
	assert(large.content[0].text.includes("line-3000"), "truncated output did not retain the tail");

	const unicodeCwd = join(scratchDir, "working directory 雪");
	await mkdir(unicodeCwd);
	const foregroundCwd = await foreground.execute(
		"runtime-cwd",
		{ command: "Write-Output (Get-Location).Path" },
		undefined,
		undefined,
		{ ...ctx, cwd: unicodeCwd },
	);
	assert(foregroundCwd.content[0].text.trim() === unicodeCwd, "Pi's tool definition ignored runtime ctx.cwd");
	const cwdJob = `cwd-${process.pid}`;
	startedJobs.add(cwdJob);
	await requiredTool("pwsh-start-job").execute(
		"cwd-start",
		{ name: cwdJob, command: "Write-Output (Get-Location).Path", workingDirectory: unicodeCwd },
		undefined,
		undefined,
		ctx,
	);
	await waitForJob(cwdJob, "exited");
	const cwdOutput = await requiredTool("pwsh-get-job-output").execute("cwd-output", { name: cwdJob });
	assert(cwdOutput.content[0].text.includes(unicodeCwd), "background Unicode working directory was not preserved");
	await removeJob(cwdJob);

	let missingCwdError = "";
	try {
		await requiredTool("pwsh-start-job").execute(
			"missing-cwd",
			{ name: `missing-cwd-${process.pid}`, command: "Write-Output unreachable", workingDirectory: join(scratchDir, "missing") },
			undefined,
			undefined,
			ctx,
		);
	} catch (error) {
		missingCwdError = String(error);
	}
	assert(missingCwdError.length > 0, "background start accepted a nonexistent working directory");

	const preAborted = new AbortController();
	preAborted.abort();
	let startAbortError = "";
	try {
		await requiredTool("pwsh-start-job").execute(
			"pre-aborted-start",
			{ name: `pre-aborted-${process.pid}`, command: "Write-Output unreachable" },
			preAborted.signal,
			undefined,
			ctx,
		);
	} catch (error) {
		startAbortError = String(error);
	}
	assert(startAbortError.includes("aborted"), "pre-aborted background start was not rejected");

	const duplicateJob = `duplicate-${process.pid}`;
	startedJobs.add(duplicateJob);
	const duplicateStarts = await Promise.allSettled([
		requiredTool("pwsh-start-job").execute(
			"duplicate-first",
			{ name: duplicateJob, command: "Start-Sleep -Milliseconds 300" },
			undefined,
			undefined,
			ctx,
		),
		requiredTool("pwsh-start-job").execute(
			"duplicate-second",
			{ name: duplicateJob, command: "Start-Sleep -Milliseconds 300" },
			undefined,
			undefined,
			ctx,
		),
	]);
	assert(
		duplicateStarts.filter(({ status }) => status === "fulfilled").length === 1 &&
			duplicateStarts.filter(({ status }) => status === "rejected").length === 1,
		"concurrent duplicate job starts were not serialized",
	);
	await removeJob(duplicateJob);

	const completedJob = `complete-${process.pid}`;
	startedJobs.add(completedJob);
	const completedStart = await requiredTool("pwsh-start-job").execute(
		"job-start",
		{
			name: completedJob,
			command: "Write-Output job-started; Start-Sleep -Milliseconds 300; Write-Output job-finished",
		},
		undefined,
		undefined,
		ctx,
	);
	if (process.platform !== "win32") {
		const directoryMode = (await stat(dirname(completedStart.details.mergedPath))).mode & 0o777;
		const logMode = (await stat(completedStart.details.mergedPath)).mode & 0o777;
		assert(directoryMode === 0o700, `owned log directory mode was ${directoryMode.toString(8)}, expected 700`);
		assert(logMode === 0o600, `owned log mode was ${logMode.toString(8)}, expected 600`);
	}
	const completedStatus = await waitForJob(completedJob, "exited");
	const completedOutput = await requiredTool("pwsh-get-job-output").execute(
		"job-output",
		{ name: completedJob },
	);
	assert(completedStatus.includes("Exit code: 0"), "completed background job had the wrong status");
	assert(completedOutput.content[0].text.includes("job-finished"), "background job output was incomplete");
	assert(completedOutput.details.outputs?.[0]?.content.includes("job-finished"), "semantic job output details were missing");
	assert(
		notifications.some(({ message, level }) => level === "info" && message.includes(completedJob) && message.includes("completed")),
		"natural background completion notification was missing",
	);
	assert(
		statusUpdates.some(({ key, text }) => key === "powershell-jobs" && text?.includes("done")),
		"sticky job status did not report a completed job",
	);
	const outputRenderer = requiredTool("pwsh-get-job-output");
	const outputRenderArgs = { name: completedJob };
	const outputRenderState = { operationStartedAt: Date.now() - 1_250 };
	const outputRenderContext = createRenderContext(outputRenderArgs, { state: outputRenderState });
	const collapsedOutputComponent = outputRenderer.renderResult(
		completedOutput,
		{ expanded: false, isPartial: false },
		testTheme,
		outputRenderContext,
	);
	const collapsedOutputText = collapsedOutputComponent.render(70).join("\n");
	assert(
		collapsedOutputText.includes(completedJob) && collapsedOutputText.includes("job-finished") && collapsedOutputText.includes("Took"),
		"collapsed output renderer omitted job state, newest output, or operation timing",
	);
	const reusedOutputComponent = outputRenderer.renderResult(
		completedOutput,
		{ expanded: false, isPartial: false },
		testTheme,
		createRenderContext(outputRenderArgs, { state: outputRenderState, lastComponent: collapsedOutputComponent }),
	);
	assert(reusedOutputComponent === collapsedOutputComponent, "job output renderer did not reuse its component");

	selectResponses.push(
		(_title, options) => options.find((option) => option.startsWith(`${completedJob} ·`)),
		"View output",
		undefined,
	);
	await commands.get("pwsh-jobs").handler("", ctx);
	assert(
		editorViews.some(({ title, prefill }) => title.includes(completedJob) && prefill.includes("job-finished")),
		"interactive job manager did not show captured output",
	);
	assert(
		!completedOutput.content[0].text.includes(completedStart.details.mergedPath) &&
			completedOutput.details.mergedPath === undefined,
		"default output unexpectedly exposed the full log path",
	);
	const completedFullOutput = await requiredTool("pwsh-get-job-output").execute("job-full-output", {
		name: completedJob,
		full: true,
	});
	assert(
		completedFullOutput.content[0].text.includes(completedStart.details.mergedPath) &&
			completedFullOutput.details.mergedPath === completedStart.details.mergedPath,
		"full output did not expose the full log path",
	);
	await removeJob(completedJob);

	const partialOpenJob = `partial-open-${process.pid}`;
	const ownedLogDirectory = dirname(completedStart.details.mergedPath);
	const ownedLogsBeforePartialOpen = await readdir(ownedLogDirectory);
	let partialOpenError = "";
	try {
		await requiredTool("pwsh-start-job").execute(
			"partial-open-start",
			{
				name: partialOpenJob,
				command: "Write-Output unreachable",
				stdout: "default",
				stderr: join(scratchDir, "missing-log-directory", "stderr.log"),
			},
			undefined,
			undefined,
			ctx,
		);
	} catch (error) {
		partialOpenError = String(error);
	}
	assert(partialOpenError.length > 0, "background start accepted an invalid stderr log path");
	const ownedLogsAfterPartialOpen = await readdir(ownedLogDirectory);
	assert(
		JSON.stringify(ownedLogsAfterPartialOpen.sort()) === JSON.stringify(ownedLogsBeforePartialOpen.sort()),
		"a partially opened owned log survived background start failure",
	);

	const collisionBaseJob = `owned-collision-${process.pid}`;
	const collisionSuffixJob = `${collisionBaseJob}-stdout`;
	startedJobs.add(collisionBaseJob);
	const collisionBaseStart = await requiredTool("pwsh-start-job").execute(
		"owned-collision-base-start",
		{
			name: collisionBaseJob,
			command: "Write-Output collision-base-marker",
			stdout: "default",
			stderr: "null",
		},
		undefined,
		undefined,
		ctx,
	);
	await waitForJob(collisionBaseJob, "exited");
	startedJobs.add(collisionSuffixJob);
	const collisionSuffixStart = await requiredTool("pwsh-start-job").execute(
		"owned-collision-suffix-start",
		{ name: collisionSuffixJob, command: "Write-Output collision-suffix-marker" },
		undefined,
		undefined,
		ctx,
	);
	await waitForJob(collisionSuffixJob, "exited");
	assert(
		collisionBaseStart.details.stdoutPath !== collisionSuffixStart.details.mergedPath,
		"owned jobs with colliding legacy names shared a log path",
	);
	const collisionBaseLog = await readFile(collisionBaseStart.details.stdoutPath, "utf8");
	const collisionSuffixLog = await readFile(collisionSuffixStart.details.mergedPath, "utf8");
	assert(
		collisionBaseLog.includes("collision-base-marker") && !collisionBaseLog.includes("collision-suffix-marker"),
		"the first colliding owned log contained another job's output",
	);
	assert(
		collisionSuffixLog.includes("collision-suffix-marker") && !collisionSuffixLog.includes("collision-base-marker"),
		"the second colliding owned log contained another job's output",
	);
	await removeJob(collisionBaseJob);
	assert(
		existsSync(collisionSuffixStart.details.mergedPath) &&
			(await readFile(collisionSuffixStart.details.mergedPath, "utf8")).includes("collision-suffix-marker"),
		"removing one colliding job deleted the other job's owned log",
	);
	await removeJob(collisionSuffixJob);
	if (process.platform === "win32") {
		const caseUpperJob = `Owned-Case-${process.pid}`;
		const caseLowerJob = caseUpperJob.toLowerCase();
		startedJobs.add(caseUpperJob);
		const caseUpperStart = await requiredTool("pwsh-start-job").execute(
			"owned-case-upper-start",
			{ name: caseUpperJob, command: "Write-Output case-upper-marker" },
			undefined,
			undefined,
			ctx,
		);
		await waitForJob(caseUpperJob, "exited");
		startedJobs.add(caseLowerJob);
		const caseLowerStart = await requiredTool("pwsh-start-job").execute(
			"owned-case-lower-start",
			{ name: caseLowerJob, command: "Write-Output case-lower-marker" },
			undefined,
			undefined,
			ctx,
		);
		await waitForJob(caseLowerJob, "exited");
		assert(
			caseUpperStart.details.mergedPath.toLowerCase() !== caseLowerStart.details.mergedPath.toLowerCase(),
			"case-variant Windows job names shared an owned log path",
		);
		assert(
			(await readFile(caseUpperStart.details.mergedPath, "utf8")).includes("case-upper-marker") &&
				(await readFile(caseLowerStart.details.mergedPath, "utf8")).includes("case-lower-marker"),
			"case-variant Windows job logs did not retain distinct output",
		);
		await removeJob(caseUpperJob);
		assert(existsSync(caseLowerStart.details.mergedPath), "removing a case-variant job deleted its peer's log");
		await removeJob(caseLowerJob);
	}

	const environmentJob = `environment-${process.pid}`;
	startedJobs.add(environmentJob);
	await requiredTool("pwsh-start-job").execute(
		"environment-start",
		{
			name: environmentJob,
			command:
				'Write-Output "$env:PI_SESSION_ID|$env:PI_SESSION_FILE|$env:PI_PROVIDER|$env:PI_MODEL|$env:PI_REASONING_LEVEL|$env:POWERSHELL_EXTENSION_TEST"',
			env: { POWERSHELL_EXTENSION_TEST: "job-env-雪" },
		},
		undefined,
		undefined,
		ctx,
	);
	await waitForJob(environmentJob, "exited");
	const environmentOutput = await requiredTool("pwsh-get-job-output").execute("environment-output", {
		name: environmentJob,
	});
	const environmentText = environmentOutput.content[0].text;
	assert(
		environmentText.includes("powershell-test-session|") &&
			environmentText.includes("powershell-test-session.jsonl|openai|powershell-test-model|medium|job-env-雪"),
		`background PI environment was incomplete:\n${environmentText}`,
	);
	await removeJob(environmentJob);

	const failedJob = `failed-${process.pid}`;
	startedJobs.add(failedJob);
	await requiredTool("pwsh-start-job").execute(
		"failed-start",
		{ name: failedJob, command: "Write-Output before-background-failure; exit 7" },
		undefined,
		undefined,
		ctx,
	);
	const failedStatus = await waitForJob(failedJob, "exited");
	assert(failedStatus.includes("Exit code: 7"), "background nonzero exit code was not retained");
	const failedMessage = sentMessages.find(({ message }) => message.details?.name === failedJob);
	assert(
		failedMessage?.message.customType === "powershell-job-failed" && failedMessage.options?.triggerTurn === false,
		"natural background failure was not persisted without triggering a turn",
	);
	assert(
		notifications.some(({ message, level }) => level === "error" && message.includes(failedJob)),
		"natural background failure notification was missing",
	);
	assert(
		statusUpdates.some(({ key, text }) => key === "powershell-jobs" && text?.includes("failed")),
		"sticky job status did not report a failed job",
	);
	const failureMessageText = messageRenderers
		.get("powershell-job-failed")(failedMessage.message, { expanded: true }, testTheme)
		.render(100)
		.join("\n");
	assert(
		failureMessageText.includes(failedJob) && failureMessageText.includes("exit 7") && failureMessageText.includes("pwsh-get-job-output"),
		"durable failure renderer omitted recovery details",
	);
	await removeJob(failedJob);

	const crashedRootJob = `root-crash-${process.pid}`;
	startedJobs.add(crashedRootJob);
	const failureMessagesBeforeCrash = sentMessages.filter(({ message }) => message.details?.name === crashedRootJob).length;
	await requiredTool("pwsh-start-job").execute(
		"root-crash-start",
		{ name: crashedRootJob, command: 'Write-Output root-crash-ready; [System.Diagnostics.Process]::GetCurrentProcess().Kill()' },
		undefined,
		undefined,
		ctx,
	);
	const crashedRootStatus = await waitForJob(crashedRootJob, "exited");
	assert(!crashedRootStatus.includes("Exit code: 0"), "unexpected root PowerShell crash was reported as success");
	await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	const rootCrashFailureMessages = sentMessages.filter(({ message }) => message.details?.name === crashedRootJob);
	assert(
		rootCrashFailureMessages.length === failureMessagesBeforeCrash + 1 &&
			rootCrashFailureMessages.at(-1)?.message.customType === "powershell-job-failed",
		"unexpected root PowerShell crash did not produce exactly one durable failure",
	);
	await removeJob(crashedRootJob);

	const stoppedJob = `stop-${process.pid}`;
	startedJobs.add(stoppedJob);
	await requiredTool("pwsh-start-job").execute(
		"stop-start",
		{ name: stoppedJob, command: "Write-Output ready; Start-Sleep -Seconds 30" },
		undefined,
		undefined,
		ctx,
	);
	await waitForOutput(stoppedJob, "ready");
	await requiredTool("pwsh-stop-job").execute("stop", { name: stoppedJob }, undefined, undefined, ctx);
	const stoppedStatus = await requiredTool("pwsh-get-job").execute("stop-status", { name: stoppedJob });
	assert(stoppedStatus.content[0].text.includes("Status: exited"), "stopped job remained running");
	assert(
		!notifications.some(({ message }) => message.includes(stoppedJob) && message.includes("completed")),
		"explicitly stopped job produced a natural-completion notification",
	);
	await removeJob(stoppedJob);

	const concurrentRemovalJob = `concurrent-remove-${process.pid}`;
	startedJobs.add(concurrentRemovalJob);
	await requiredTool("pwsh-start-job").execute(
		"concurrent-remove-start",
		{
			name: concurrentRemovalJob,
			command: `& '${quotedNode}' -e 'console.log("concurrent-child=" + process.pid); setTimeout(() => {}, 30000)'`,
		},
		undefined,
		undefined,
		ctx,
	);
	const concurrentRemovalOutput = await waitForOutputMatch(concurrentRemovalJob, /concurrent-child=(\d+)/);
	const concurrentRemovalPid = Number(concurrentRemovalOutput.match(/concurrent-child=(\d+)/)?.[1]);
	assert(Number.isInteger(concurrentRemovalPid), "could not capture the concurrently removed job's child pid");
	const concurrentRemovalResults = await Promise.allSettled([
		requiredTool("pwsh-stop-job").execute("concurrent-stop", { name: concurrentRemovalJob }),
		requiredTool("pwsh-remove-job").execute("concurrent-remove-first", { name: concurrentRemovalJob }),
		requiredTool("pwsh-remove-job").execute("concurrent-remove-second", { name: concurrentRemovalJob }),
	]);
	assert(
		concurrentRemovalResults.every(({ status }) => status === "fulfilled"),
		"concurrent stop/removes of one running job did not all settle successfully",
	);
	startedJobs.delete(concurrentRemovalJob);
	await waitForProcessExit(concurrentRemovalPid);
	const afterConcurrentRemoval = await requiredTool("pwsh-get-job").execute("concurrent-removed", {});
	assert(afterConcurrentRemoval.content[0].text === "No active jobs.", "concurrent removal left the job tracked");
	startedJobs.add(concurrentRemovalJob);
	await requiredTool("pwsh-start-job").execute(
		"concurrent-remove-restart",
		{ name: concurrentRemovalJob, command: "Write-Output concurrent-restart-marker; Start-Sleep -Seconds 30" },
		undefined,
		undefined,
		ctx,
	);
	await waitForOutput(concurrentRemovalJob, "concurrent-restart-marker");
	const concurrentRestartStatus = await requiredTool("pwsh-get-job").execute("concurrent-restart-status", {
		name: concurrentRemovalJob,
	});
	assert(concurrentRestartStatus.content[0].text.includes("Status: running"), "immediate same-name restart was not tracked");
	await removeJob(concurrentRemovalJob);

	const managedJob = `managed-${process.pid}`;
	startedJobs.add(managedJob);
	await requiredTool("pwsh-start-job").execute(
		"managed-start",
		{ name: managedJob, command: "Write-Output managed-ready; Start-Sleep -Seconds 30" },
		undefined,
		undefined,
		ctx,
	);
	await waitForOutput(managedJob, "managed-ready");
	selectResponses.push(
		(_title, options) => options.find((option) => option.startsWith(`${managedJob} ·`)),
		"Stop job",
		undefined,
	);
	confirmResponses.push(true);
	await commands.get("pwsh-jobs").handler("", ctx);
	const managedStopped = await requiredTool("pwsh-get-job").execute("managed-stopped", { name: managedJob });
	assert(managedStopped.content[0].text.includes("Status: exited"), "interactive job manager did not stop the job");
	selectResponses.push(
		(_title, options) => options.find((option) => option.startsWith(`${managedJob} ·`)),
		"Remove job and owned logs",
	);
	confirmResponses.push(true);
	await commands.get("pwsh-jobs").handler("", ctx);
	const afterManagedRemove = await requiredTool("pwsh-get-job").execute("managed-removed", {});
	assert(afterManagedRemove.content[0].text === "No active jobs.", "interactive job manager did not remove the job");
	startedJobs.delete(managedJob);

	const staleConfirmationJob = `stale-confirm-${process.pid}`;
	startedJobs.add(staleConfirmationJob);
	await requiredTool("pwsh-start-job").execute(
		"stale-confirm-old-start",
		{ name: staleConfirmationJob, command: "Write-Output stale-old-marker" },
		undefined,
		undefined,
		ctx,
	);
	await waitForJob(staleConfirmationJob, "exited");
	selectResponses.push(
		(_title, options) => options.find((option) => option.startsWith(`${staleConfirmationJob} ·`)),
		"Remove job and owned logs",
	);
	let staleReplacementStart;
	confirmResponses.push(async () => {
		await requiredTool("pwsh-remove-job").execute("stale-confirm-remove-old", { name: staleConfirmationJob });
		startedJobs.delete(staleConfirmationJob);
		startedJobs.add(staleConfirmationJob);
		staleReplacementStart = await requiredTool("pwsh-start-job").execute(
			"stale-confirm-replacement-start",
			{ name: staleConfirmationJob, command: "Write-Output stale-replacement-marker; Start-Sleep -Seconds 30" },
			undefined,
			undefined,
			ctx,
		);
		await waitForOutput(staleConfirmationJob, "stale-replacement-marker");
		return true;
	});
	await commands.get("pwsh-jobs").handler("", ctx);
	const staleReplacementStatus = await requiredTool("pwsh-get-job").execute("stale-confirm-status", {
		name: staleConfirmationJob,
	});
	assert(staleReplacementStatus.content[0].text.includes("Status: running"), "stale UI removal removed the replacement job");
	assert(
		staleReplacementStart?.details.mergedPath && existsSync(staleReplacementStart.details.mergedPath),
		"stale UI removal deleted the replacement job's owned log",
	);
	assert(
		(await readFile(staleReplacementStart.details.mergedPath, "utf8")).includes("stale-replacement-marker"),
		"replacement output was missing after stale UI removal",
	);
	await removeJob(staleConfirmationJob);

	const directChildJob = `direct-child-${process.pid}`;
	startedJobs.add(directChildJob);
	await requiredTool("pwsh-start-job").execute(
		"direct-child-start",
		{
			name: directChildJob,
			command: `& '${quotedNode}' -e 'console.log("child-pid=" + process.pid); setTimeout(() => {}, 30000)'`,
		},
		undefined,
		undefined,
		ctx,
	);
	const directChildOutput = await waitForOutputMatch(directChildJob, /child-pid=(\d+)/);
	const directChildPid = Number(directChildOutput.match(/child-pid=(\d+)/)?.[1]);
	assert(Number.isInteger(directChildPid), "could not capture the directly launched child process id");
	await requiredTool("pwsh-stop-job").execute("direct-child-stop", { name: directChildJob });
	await waitForProcessExit(directChildPid);
	await removeJob(directChildJob);

	if (process.platform !== "win32") {
		const resistantChildJob = `sigterm-resistant-${process.pid}`;
		startedJobs.add(resistantChildJob);
		await requiredTool("pwsh-start-job").execute(
			"sigterm-resistant-start",
			{
				name: resistantChildJob,
				command: `& '${quotedNode}' -e 'process.on("SIGTERM",()=>{}); console.log("resistant-child=" + process.pid); console.log("resistant-ready"); setInterval(()=>{},1000)'`,
			},
			undefined,
			undefined,
			ctx,
		);
		const resistantOutput = await waitForOutputMatch(resistantChildJob, /resistant-child=(\d+)[\s\S]*resistant-ready/);
		const resistantChildPid = Number(resistantOutput.match(/resistant-child=(\d+)/)?.[1]);
		assert(Number.isInteger(resistantChildPid), "could not capture the SIGTERM-resistant direct child's pid");
		const resistantStopStartedAt = Date.now();
		await requiredTool("pwsh-stop-job").execute("sigterm-resistant-stop", { name: resistantChildJob });
		const resistantStopMs = Date.now() - resistantStopStartedAt;
		assert(
			resistantStopMs >= 2_500 && resistantStopMs < 9_000,
			`SIGTERM-resistant stop did not use the bounded escalation window: ${resistantStopMs}ms`,
		);
		await waitForProcessExit(resistantChildPid);
		await removeJob(resistantChildJob);

		const descendantJob = `descendant-${process.pid}`;
		startedJobs.add(descendantJob);
		await requiredTool("pwsh-start-job").execute(
			"descendant-start",
			{
				name: descendantJob,
				command:
					'$child = Start-Process -FilePath (Join-Path $PSHOME "pwsh") -ArgumentList "-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 30" -PassThru; Write-Output ("child-pid=" + $child.Id)',
			},
			undefined,
			undefined,
			ctx,
		);
		const descendantOutput = await waitForOutputMatch(descendantJob, /child-pid=(\d+)/);
		const descendantPid = Number(descendantOutput.match(/child-pid=(\d+)/)?.[1]);
		assert(Number.isInteger(descendantPid), "could not capture the descendant process id");
		const descendantStatus = await waitForJob(descendantJob, "exited");
		assert(descendantStatus.includes("Exit code: 0"), "root exit did not naturally complete the whole supervised job");
		await waitForProcessExit(descendantPid);
		await removeJob(descendantJob);
	}

	const customLogJob = `custom-${process.pid}`;
	const customLog = join(scratchDir, "caller-owned.log");
	startedJobs.add(customLogJob);
	await requiredTool("pwsh-start-job").execute(
		"custom-start",
		{ name: customLogJob, command: "Write-Output caller-owned", stdout: customLog, stderr: "null" },
		undefined,
		undefined,
		ctx,
	);
	await waitForJob(customLogJob, "exited");
	assert((await readFile(customLog, "utf8")).includes("caller-owned"), "caller-owned log capture was incomplete");
	await removeJob(customLogJob);
	assert(existsSync(customLog), "removing a job deleted its caller-owned log");

	// Quotas count the combined captured UTF-8 bytes, retain only whole characters, and fail the job durably.
	const defaultQuotaJob = `quota-default-${process.pid}`;
	startedJobs.add(defaultQuotaJob);
	const defaultQuotaStart = await requiredTool("pwsh-start-job").execute(
		"quota-default-start",
		{ name: defaultQuotaJob, command: "[Console]::Out.Write(('x' * 11534336)); Start-Sleep -Seconds 30" },
		undefined, undefined, ctx,
	);
	await waitForJob(defaultQuotaJob, "exited");
	assert((await stat(defaultQuotaStart.details.mergedPath)).size === 10 * 1024 * 1024, "default job quota did not cap actual captured output at 10 MiB");
	const defaultQuotaStatus = await requiredTool("pwsh-get-job").execute("quota-default-details", { name: defaultQuotaJob });
	assert(defaultQuotaStatus.details.job.outputError?.includes("10485760-byte"), "default quota overflow was not reported");
	await removeJob(defaultQuotaJob);

	const boundaryJob = `quota-boundary-${process.pid}`;
	startedJobs.add(boundaryJob);
	const boundaryStart = await requiredTool("pwsh-start-job").execute(
		"quota-boundary-start",
		{ name: boundaryJob, command: "[Console]::Out.Write('abc雪')", maxLogBytes: 6 },
		undefined, undefined, ctx,
	);
	await waitForJob(boundaryJob, "exited");
	assert((await readFile(boundaryStart.details.mergedPath)).equals(Buffer.from("abc雪")), "an exact six-byte quota boundary failed");
	const boundaryDetails = await requiredTool("pwsh-get-job").execute("quota-boundary-details", { name: boundaryJob });
	assert(!boundaryDetails.details.job.outputError, "an exact quota boundary incorrectly reported overflow");
	await removeJob(boundaryJob);

	const unicodeOverflowJob = `quota-unicode-${process.pid}`;
	startedJobs.add(unicodeOverflowJob);
	const unicodeOverflowStart = await requiredTool("pwsh-start-job").execute(
		"quota-unicode-start",
		{ name: unicodeOverflowJob, command: "[Console]::Out.Write('abc雪🚀')", maxLogBytes: 8 },
		undefined, undefined, ctx,
	);
	const unicodeOverflowStatus = await waitForJob(unicodeOverflowJob, "exited");
	const unicodeOverflowLog = await readFile(unicodeOverflowStart.details.mergedPath);
	assert(unicodeOverflowLog.equals(Buffer.from("abc雪")), "quota overflow wrote a partial UTF-8 emoji or the wrong prefix");
	const unicodeOverflowDetails = await requiredTool("pwsh-get-job").execute("quota-unicode-details", { name: unicodeOverflowJob });
	const unicodeOverflowOutput = await requiredTool("pwsh-get-job-output").execute("quota-unicode-output", { name: unicodeOverflowJob });
	assert(unicodeOverflowDetails.details.job.outputError && unicodeOverflowOutput.details.outputError, "quota error was not exposed by both job detail tools");
	assert(unicodeOverflowStatus.includes("Output capture error:"), "quota failure was not persistent in job status");
	assert(statusUpdates.some(({ key, text }) => key === "powershell-jobs" && text?.includes("failed")), "output failure with exit code 0 did not set failed UI status");
	assert(sentMessages.filter(({ message }) => message.details?.name === unicodeOverflowJob).length === 1, "quota failure was not emitted exactly once");
	const zeroExitOverflowDetails = {
		...unicodeOverflowDetails,
		details: { ...unicodeOverflowDetails.details, job: { ...unicodeOverflowDetails.details.job, exitCode: 0 } },
	};
	const quotaRenderText = requiredTool("pwsh-get-job")
		.renderResult(zeroExitOverflowDetails, { isPartial: false }, testTheme, createRenderContext({ name: unicodeOverflowJob }))
		.render(100).join("\n");
	assert(quotaRenderText.includes("failed"), "get-job rendered an output-capture failure with exit code 0 as successful");
	await removeJob(unicodeOverflowJob);
	assert(!existsSync(unicodeOverflowStart.details.mergedPath), "removing a quota-failed job preserved its owned log");

	const separateQuotaJob = `quota-separate-${process.pid}`;
	startedJobs.add(separateQuotaJob);
	const separateQuotaStart = await requiredTool("pwsh-start-job").execute(
		"quota-separate-start",
		{ name: separateQuotaJob, command: "[Console]::Out.Write('abc'); Start-Sleep -Milliseconds 200; [Console]::Error.Write('雪🚀'); Start-Sleep -Seconds 30", stdout: "default", stderr: "default", maxLogBytes: 8 },
		undefined, undefined, ctx,
	);
	await waitForOutput(separateQuotaJob, "abc");
	await waitForJob(separateQuotaJob, "exited");
	assert((await readFile(separateQuotaStart.details.stdoutPath)).equals(Buffer.from("abc")), "combined quota corrupted separate stdout");
	assert((await readFile(separateQuotaStart.details.stderrPath)).equals(Buffer.from("雪")), "combined quota did not stop at a whole UTF-8 stderr prefix");
	assert((await stat(separateQuotaStart.details.stdoutPath)).size + (await stat(separateQuotaStart.details.stderrPath)).size === 6, "separate logs did not share one capture budget");
	await removeJob(separateQuotaJob);

	const discardQuotaJob = `quota-discard-${process.pid}`;
	startedJobs.add(discardQuotaJob);
	const discardStart = await requiredTool("pwsh-start-job").execute(
		"quota-discard-start",
		{ name: discardQuotaJob, command: "[Console]::Out.Write(('x' * 100000)); [Console]::Error.Write('雪')", stdout: "null", stderr: "default", maxLogBytes: 3 },
		undefined, undefined, ctx,
	);
	const discardStatus = await waitForJob(discardQuotaJob, "exited");
	assert(discardStatus.includes("Exit code: 0") && !(await requiredTool("pwsh-get-job").execute("quota-discard-details", { name: discardQuotaJob })).details.job.outputError, "discarded output consumed quota");
	assert((await readFile(discardStart.details.stderrPath)).equals(Buffer.from("雪")), "captured stream failed after large discarded output");
	await removeJob(discardQuotaJob);

	const callerQuotaJob = `quota-caller-${process.pid}`;
	const callerQuotaOut = join(scratchDir, "caller-quota-out.log");
	const callerQuotaErr = join(scratchDir, "caller-quota-err.log");
	startedJobs.add(callerQuotaJob);
	await requiredTool("pwsh-start-job").execute("quota-caller-start", {
		name: callerQuotaJob, command: "[Console]::Out.Write('abc'); [Console]::Error.Write('雪🚀'); Start-Sleep -Seconds 30",
		stdout: callerQuotaOut, stderr: callerQuotaErr, maxLogBytes: 8,
	}, undefined, undefined, ctx);
	await waitForJob(callerQuotaJob, "exited");
	assert((await stat(callerQuotaOut)).size + (await stat(callerQuotaErr)).size <= 8, "caller-owned files did not share the quota");
	await removeJob(callerQuotaJob);
	assert(existsSync(callerQuotaOut) && existsSync(callerQuotaErr), "removing an overflowed job deleted caller-owned logs");

	for (const [suffix, maxLogBytes] of [["zero", 0], ["fraction", 1.5], ["huge", 1024 * 1024 * 1024 + 1]]) {
		let quotaValidationError = "";
		try {
			await requiredTool("pwsh-start-job").execute(`quota-invalid-${suffix}`, {
				name: `quota-invalid-${suffix}-${process.pid}`, command: "Write-Output unreachable", maxLogBytes,
			}, undefined, undefined, ctx);
		} catch (error) {
			quotaValidationError = String(error);
		}
		assert(quotaValidationError.includes("integer from 1 through 1073741824"), `invalid maxLogBytes ${maxLogBytes} was accepted`);
	}

	const nativeQuotaJob = `quota-native-${process.pid}`;
	startedJobs.add(nativeQuotaJob);
	const nativeQuotaStart = await requiredTool("pwsh-start-job").execute("quota-native-start", {
		name: nativeQuotaJob,
		command: `& '${quotedNode}' -e 'console.log("quota-child="+process.pid);console.log("quota-ready");setTimeout(()=>process.stdout.write("x".repeat(100000)),500);setInterval(()=>{},1000)'`,
		maxLogBytes: 64,
	}, undefined, undefined, ctx);
	const nativeQuotaReady = await waitForOutputMatch(nativeQuotaJob, /quota-child=(\d+)[\s\S]*quota-ready/);
	const nativeQuotaPid = Number(nativeQuotaReady.match(/quota-child=(\d+)/)?.[1]);
	assert(Number.isInteger(nativeQuotaPid), "could not capture quota-overflow native child pid before overflow");
	await waitForJob(nativeQuotaJob, "exited");
	await waitForProcessExit(nativeQuotaPid);
	assert((await stat(nativeQuotaStart.details.mergedPath)).size <= 64, "native-child overflow exceeded its log quota");
	const nativeFailureMessages = sentMessages.filter(({ message }) => message.details?.name === nativeQuotaJob);
	assert(nativeFailureMessages.length === 1 && nativeFailureMessages[0].message.details.outputError?.includes("64-byte"), "native-child quota failure was not durably emitted once with its reason");
	await removeJob(nativeQuotaJob);

	if (process.platform !== "win32" && existsSync("/dev/full")) {
		const writeFailureJob = `write-failure-${process.pid}`;
		startedJobs.add(writeFailureJob);
		await requiredTool("pwsh-start-job").execute(
			"write-failure-start",
			{
				name: writeFailureJob,
				command: "[Console]::Out.Write(('x' * 1000000)); Start-Sleep -Seconds 30",
				stdout: "/dev/full",
				stderr: "null",
			},
			undefined,
			undefined,
			ctx,
		);
		const writeFailureStatus = await waitForJob(writeFailureJob, "exited");
		assert(writeFailureStatus.includes("Output capture error:"), "a background write failure was not reported");
		const writeFailureDetails = await requiredTool("pwsh-get-job").execute("write-failure-details", { name: writeFailureJob });
		assert(writeFailureDetails.details.job.outputError, "write failure was not retained in job details after automatic stop");
		const writeFailureRender = requiredTool("pwsh-get-job")
			.renderResult(writeFailureDetails, { isPartial: false }, testTheme, createRenderContext({ name: writeFailureJob }))
			.render(100).join("\n");
		assert(writeFailureRender.includes("failed"), "write-failed job renderer did not show failed status");
		assert(sentMessages.filter(({ message }) => message.details?.name === writeFailureJob).length === 1, "write failure was not durably emitted exactly once");
		await removeJob(writeFailureJob);
	}

	const separateStreamsJob = `streams-${process.pid}`;
	startedJobs.add(separateStreamsJob);
	await requiredTool("pwsh-start-job").execute(
		"streams-start",
		{
			name: separateStreamsJob,
			command: '[Console]::Out.WriteLine("stdout-only"); [Console]::Error.WriteLine("stderr-only")',
			stdout: "default",
			stderr: "default",
		},
		undefined,
		undefined,
		ctx,
	);
	await waitForJob(separateStreamsJob, "exited");
	const separateOutput = await requiredTool("pwsh-get-job-output").execute("streams-output", {
		name: separateStreamsJob,
	});
	assert(
		separateOutput.content[0].text.includes("stdout-only") &&
			separateOutput.content[0].text.includes("stderr-only") &&
			separateOutput.content[0].text.includes("stdout (") &&
			separateOutput.content[0].text.includes("stderr ("),
		"separate stdout/stderr capture failed",
	);
	const separateCursorOutput = await requiredTool("pwsh-get-job-output").execute("streams-cursor-output", {
		name: separateStreamsJob,
		cursor: {},
	});
	assert(
		separateCursorOutput.content[0].text.includes("stdout-only") &&
			separateCursorOutput.content[0].text.includes("stderr-only") &&
			separateCursorOutput.details.nextCursor.stdout > 0 &&
			separateCursorOutput.details.nextCursor.stderr > 0,
		"separate stdout/stderr cursor reads failed",
	);
	await removeJob(separateStreamsJob);

	const mergedUnicodeJob = `merged-unicode-${process.pid}`;
	startedJobs.add(mergedUnicodeJob);
	const mergedUnicodeStart = await requiredTool("pwsh-start-job").execute(
		"merged-unicode-start",
		{ name: mergedUnicodeJob, command: `& '${quotedNode}' -e '${nativeInterleaveScript}'` },
		undefined,
		undefined,
		ctx,
	);
	await waitForJob(mergedUnicodeJob, "exited");
	const mergedUnicodeOutput = await requiredTool("pwsh-get-job-output").execute("merged-unicode-output", {
		name: mergedUnicodeJob,
	});
	const mergedUnicodeText = mergedUnicodeOutput.content[0].text;
	assert(mergedUnicodeText.includes("between-雪") && mergedUnicodeText.includes("🚀"), "merged job Unicode was lost");
	assert(!mergedUnicodeText.includes("�"), "merged job output produced a replacement character");
	assert(!mergedUnicodeText.includes("\uFEFF"), "merged job output retained a per-stream UTF-8 BOM");
	const mergedUnicodeLog = await readFile(mergedUnicodeStart.details.mergedPath, "utf8");
	assert(!mergedUnicodeLog.includes("�"), "the normalized merged log contained a replacement character");
	assert(!mergedUnicodeLog.includes("\uFEFF"), "the normalized merged log retained a per-stream UTF-8 BOM");
	await removeJob(mergedUnicodeJob);

	const largeJob = `large-job-${process.pid}`;
	startedJobs.add(largeJob);
	await requiredTool("pwsh-start-job").execute(
		"large-job-start",
		{ name: largeJob, command: '1..20000 | ForEach-Object { "background-line-$_-雪" }; Write-Output "tail-🚀"' },
		undefined,
		undefined,
		ctx,
	);
	await waitForJob(largeJob, "exited");
	const largeJobOutput = await requiredTool("pwsh-get-job-output").execute("large-job-output", { name: largeJob });
	assert(largeJobOutput.content[0].text.includes("truncated=yes"), "large background output was not truncated");
	assert(largeJobOutput.content[0].text.includes("tail-🚀"), "large background output did not preserve its UTF-8 tail");
	assert(largeJobOutput.content[0].text.length < 60_000, "large background output retrieval was not bounded");
	const largeRenderArgs = { name: largeJob };
	const largeRenderContext = createRenderContext(largeRenderArgs, {
		state: { operationStartedAt: Date.now() - 500 },
	});
	const largeCollapsedComponent = outputRenderer.renderResult(
		largeJobOutput,
		{ expanded: false, isPartial: false },
		testTheme,
		largeRenderContext,
	);
	const largeCollapsedText = largeCollapsedComponent.render(60).join("\n");
	assert(
		largeCollapsedText.includes("tail-🚀") && largeCollapsedText.includes("earlier lines"),
		"collapsed large-output renderer did not show the newest five-line preview",
	);
	const largeExpandedText = outputRenderer
		.renderResult(
			largeJobOutput,
			{ expanded: true, isPartial: false },
			testTheme,
			createRenderContext(largeRenderArgs, { state: largeRenderContext.state }),
		)
		.render(60)
		.join("\n");
	assert(
		largeExpandedText.length > largeCollapsedText.length && largeExpandedText.includes("tail-🚀"),
		"expanded large-output renderer did not reveal the bounded full result",
	);
	let cursor = {};
	let incrementalOutput = "";
	let cursorChunks = 0;
	for (; cursorChunks < 20; cursorChunks++) {
		const chunk = await requiredTool("pwsh-get-job-output").execute("large-job-cursor", { name: largeJob, cursor });
		incrementalOutput += chunk.details.outputs[0].content;
		const nextCursor = chunk.details.nextCursor;
		assert(nextCursor.merged > (cursor.merged ?? -1), "incremental output cursor did not advance");
		cursor = nextCursor;
		if (!chunk.details.hasMore.merged) break;
	}
	assert(cursorChunks < 20, "incremental output did not reach the end of the log");
	const expectedIncrementalOutput = Array.from({ length: 20_000 }, (_, index) => `background-line-${index + 1}-雪`).join("\n") + "\ntail-🚀\n";
	assert(incrementalOutput.replaceAll("\r\n", "\n") === expectedIncrementalOutput, "cursor reads lost, duplicated, or corrupted output");
	await removeJob(largeJob);

	const shutdownJob = `shutdown-${process.pid}`;
	startedJobs.add(shutdownJob);
	const shutdownStart = await requiredTool("pwsh-start-job").execute(
		"shutdown-start",
		{ name: shutdownJob, command: "Write-Output shutdown-ready; Start-Sleep -Seconds 30" },
		undefined,
		undefined,
		ctx,
	);
	const shutdownLog = shutdownStart.details.mergedPath;
	await waitForOutput(shutdownJob, "shutdown-ready");
	const racingJob = `shutdown-race-${process.pid}`;
	startedJobs.add(racingJob);
	const racingStart = requiredTool("pwsh-start-job").execute(
		"shutdown-race-start",
		{ name: racingJob, command: "Write-Output should-not-survive; Start-Sleep -Seconds 30" },
		undefined,
		undefined,
		ctx,
	);
	const shutdown = handlers.get("session_shutdown")({}, ctx);
	const [racingResult, shutdownResult] = await Promise.allSettled([racingStart, shutdown]);
	assert(racingResult.status === "rejected", "an in-flight job start survived extension shutdown");
	assert(shutdownResult.status === "fulfilled", "extension shutdown failed while a job was starting");
	assert(!existsSync(shutdownLog), "session shutdown did not delete its owned job log");
	assert(!existsSync(dirname(shutdownLog)), "session shutdown did not delete its owned job log directory");
	const emptyJobs = await requiredTool("pwsh-get-job").execute("after-shutdown", {});
	assert(emptyJobs.content[0].text === "No active jobs.", "session shutdown did not clear tracked jobs");
	assert(
		statusUpdates.at(-1)?.key === "powershell-jobs" && statusUpdates.at(-1)?.text === undefined,
		"session shutdown did not clear sticky PowerShell job status",
	);
	startedJobs.delete(shutdownJob);
	startedJobs.delete(racingJob);

	await handlers.get("session_start")({}, ctx);
	const restartedJob = `after-session-start-${process.pid}`;
	startedJobs.add(restartedJob);
	const restartedStart = await requiredTool("pwsh-start-job").execute(
		"after-session-start",
		{ name: restartedJob, command: "Write-Output restarted" },
		undefined,
		undefined,
		ctx,
	);
	await waitForJob(restartedJob, "exited");
	await removeJob(restartedJob);
	await handlers.get("session_shutdown")({}, ctx);
	assert(!existsSync(dirname(restartedStart.details.mergedPath)), "restarted session log directory survived shutdown");

	console.log(
		JSON.stringify(
			{
				powershellVersion: version.stdout.trim(),
				foreground: "passed",
				availabilityProbe: "passed",
				toolActivation: process.platform === "win32" ? "passed" : "Windows-only",
				unavailableFallback: process.platform === "win32" ? "passed" : "Windows-only",
				userBashRouting: process.platform === "win32" ? "PowerShell passed" : "default shell preserved",
				multilineQuoting: "passed",
				utf8EncodingSettings: "passed",
				nativePipelineUtf8: "passed",
				interleavedForegroundUtf8: "passed",
				strictErrors: "passed",
				streamingUpdates,
				powerShellRendering: "passed",
				jobRenderers: "passed",
				jobStatusAndNotifications: "passed",
				interactiveJobManager: "passed",
				nonzeroExit: "passed",
				timeoutMs,
				abort: "passed",
				missingTaskkillCancellation: process.platform === "win32" ? "passed" : "Windows-only",
				foregroundDescendantCleanup: "passed",
				truncation: "passed",
				backgroundComplete: "passed",
				backgroundNonzeroExit: "passed",
				rootCrashFailureOnce: "passed",
				backgroundWorkingDirectory: "passed",
				backgroundStartValidation: "passed",
				duplicateStart: "passed",
				backgroundStop: "passed",
				concurrentRemovalRestart: "passed",
				staleUiRemoval: "passed",
				directChildStop: "passed",
				sigtermEscalation: process.platform === "win32" ? "Unix-only" : "passed",
				descendantStop: process.platform === "win32" ? "not run on Windows" : "passed",
				backgroundEnvironment: "passed",
				backgroundEnvironmentOverride: "passed",
				partialLogOpenCleanup: "passed",
				ownedLogCollision: "passed",
				caseVariantOwnedLogs: process.platform === "win32" ? "passed" : "Windows-only",
				failedLogWriteDrain:
					process.platform === "win32" || !existsSync("/dev/full") ? "not supported" : "passed",
				separateStreams: "passed",
				mergedInterleavedUtf8: "passed",
				boundedBackgroundTail: "passed",
				incrementalBackgroundOutput: "passed",
				fullLogPathOptIn: "passed",
				privateOwnedLogs: process.platform === "win32" ? "not applicable" : "passed",
				customLogPreserved: "passed",
				combinedJobLogQuota: "passed",
				quotaUtf8Boundaries: "passed",
				quotaAutomaticTreeStop: "passed",
				sessionShutdownRace: "passed",
				jobDirectoryCleanup: "passed",
				sessionRestart: "passed",
			},
			null,
			2,
		),
	);
} finally {
	for (const name of startedJobs) {
		await removeJob(name).catch(() => undefined);
	}
	await handlers.get("session_shutdown")({}, ctx).catch(() => undefined);
	if (fullOutputPath) await rm(fullOutputPath, { force: true }).catch(() => undefined);
	await rm(scratchDir, { recursive: true, force: true });
}

async function verifyUnavailableWindowsFallback() {
	assert(process.platform === "win32", "PowerShell-unavailable fallback mode is Windows-only");
	const localTools = new Map();
	const localHandlers = new Map();
	const localNotifications = [];
	let localActiveTools = null;
	const localPi = {
		on(event, handler) {
			localHandlers.set(event, handler);
		},
		registerTool(tool) {
			localTools.set(tool.name, tool);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		getActiveTools() {
			return localActiveTools ?? ["bash", ...localTools.keys()];
		},
		getAllTools() {
			return Array.from(localTools.values(), ({ name }) => ({ name }));
		},
		setActiveTools(names) {
			localActiveTools = [...names];
		},
	};
	const localJiti = createJiti(import.meta.url);
	const { default: localExtension } = await localJiti.import(join(repoRoot, "extensions", "powershell.ts"));
	localExtension(localPi);
	const localCtx = {
		cwd: repoRoot,
		mode: "tui",
		hasUI: true,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: { getSessionId: () => undefined, getSessionFile: () => undefined },
		ui: {
			notify(message, level) {
				localNotifications.push({ message, level });
			},
			setStatus() {},
		},
	};
	await localHandlers.get("session_start")({}, localCtx);
	assert(localActiveTools?.includes("bash"), "bash was not preserved when PowerShell was unavailable");
	assert(
		!localActiveTools?.some((name) => name === "powershell" || name.startsWith("pwsh-")),
		"unavailable PowerShell tools remained active",
	);
	assert(
		localNotifications.some(({ message, level }) => level === "warning" && message.includes("PowerShell tools were disabled")),
		"PowerShell-unavailable warning was missing",
	);
	const beforeAgentResult = await localHandlers.get("before_agent_start")({ systemPrompt: "base prompt" }, localCtx);
	assert(beforeAgentResult === undefined, "unavailable PowerShell added Windows prompt guidance");
	const userBashResult = await localHandlers.get("user_bash")(
		{ type: "user_bash", command: "echo fallback", excludeFromContext: false, cwd: repoRoot },
		localCtx,
	);
	assert(userBashResult === undefined, "unavailable PowerShell intercepted a user shell command");
}

function requiredTool(name) {
	const tool = tools.get(name);
	if (!tool) throw new Error(`Extension did not register '${name}'`);
	return tool;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function waitForJob(name, expectedStatus) {
	for (let attempt = 0; attempt < 40; attempt++) {
		const result = await requiredTool("pwsh-get-job").execute("poll-job", { name });
		const text = result.content[0].text;
		if (text.includes(`Status: ${expectedStatus}`)) return text;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(`Timed out waiting for job '${name}' to become ${expectedStatus}`);
}

async function waitForOutput(name, expectedText) {
	for (let attempt = 0; attempt < 40; attempt++) {
		const result = await requiredTool("pwsh-get-job-output").execute("poll-output", { name });
		const output = result.details.outputs.map((section) => section.content).join("\n");
		if (output.includes(expectedText)) return output;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(`Timed out waiting for '${expectedText}' from job '${name}'`);
}

async function waitForOutputMatch(name, expectedPattern) {
	for (let attempt = 0; attempt < 40; attempt++) {
		const result = await requiredTool("pwsh-get-job-output").execute("poll-output", { name });
		const output = result.details.outputs.map((section) => section.content).join("\n");
		if (expectedPattern.test(output)) return output;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(`Timed out waiting for ${expectedPattern} from job '${name}'`);
}

async function waitForProcessExit(pid) {
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error.code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	throw new Error(`Descendant process ${pid} survived job termination`);
}

async function removeJob(name) {
	if (!startedJobs.has(name)) return;
	await requiredTool("pwsh-remove-job").execute("cleanup", { name }, undefined, undefined, ctx);
	startedJobs.delete(name);
}
