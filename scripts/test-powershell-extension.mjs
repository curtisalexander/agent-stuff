#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
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
const notifications = [];
let activeToolOverride = null;
const pi = {
	on(event, handler) {
		handlers.set(event, handler);
	},
	registerTool(tool) {
		tools.set(tool.name, tool);
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
	model: { provider: "openai", id: "powershell-test-model" },
	thinkingLevel: "medium",
	sessionManager: {
		getSessionId: () => "powershell-test-session",
		getSessionFile: () => join(repoRoot, "powershell-test-session.jsonl"),
	},
	ui: {
		notify(message, level) {
			notifications.push({ message, level });
		},
	},
};

const foreground = requiredTool("powershell");
const startedJobs = new Set();
const scratchDir = await mkdtemp(join(tmpdir(), "pi-powershell-test-"));
let fullOutputPath;

try {
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
	await removeJob(failedJob);

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
	await requiredTool("pwsh-stop-job").execute("stop", { name: stoppedJob });
	const stoppedStatus = await requiredTool("pwsh-get-job").execute("stop-status", { name: stoppedJob });
	assert(stoppedStatus.content[0].text.includes("Status: exited"), "stopped job remained running");
	await removeJob(stoppedJob);

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
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));
		const descendantStatus = await requiredTool("pwsh-get-job").execute("descendant-status", {
			name: descendantJob,
		});
		assert(descendantStatus.content[0].text.includes("Status: running"), "job lost track of its live descendant");
		await requiredTool("pwsh-stop-job").execute("descendant-stop", { name: descendantJob });
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
	let cursor = {};
	let incrementalOutput = "";
	let cursorChunks = 0;
	for (; cursorChunks < 20; cursorChunks++) {
		const chunk = await requiredTool("pwsh-get-job-output").execute("large-job-cursor", { name: largeJob, cursor });
		incrementalOutput += chunk.content[0].text;
		const nextCursor = chunk.details.nextCursor;
		assert(nextCursor.merged > (cursor.merged ?? -1), "incremental output cursor did not advance");
		cursor = nextCursor;
		if (!chunk.details.hasMore.merged) break;
	}
	assert(cursorChunks < 20, "incremental output did not reach the end of the log");
	assert(incrementalOutput.includes("background-line-1"), "incremental output missed the beginning of the log");
	assert(incrementalOutput.includes("tail-🚀"), "incremental output missed the UTF-8 tail of the log");
	assert(!incrementalOutput.includes("�"), "incremental output split a UTF-8 character");
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
	const shutdown = handlers.get("session_shutdown")();
	const [racingResult, shutdownResult] = await Promise.allSettled([racingStart, shutdown]);
	assert(racingResult.status === "rejected", "an in-flight job start survived extension shutdown");
	assert(shutdownResult.status === "fulfilled", "extension shutdown failed while a job was starting");
	assert(!existsSync(shutdownLog), "session shutdown did not delete its owned job log");
	assert(!existsSync(dirname(shutdownLog)), "session shutdown did not delete its owned job log directory");
	const emptyJobs = await requiredTool("pwsh-get-job").execute("after-shutdown", {});
	assert(emptyJobs.content[0].text === "No active jobs.", "session shutdown did not clear tracked jobs");
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
	await handlers.get("session_shutdown")();
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
				nonzeroExit: "passed",
				timeoutMs,
				abort: "passed",
				foregroundDescendantCleanup: "passed",
				truncation: "passed",
				backgroundComplete: "passed",
				backgroundNonzeroExit: "passed",
				backgroundWorkingDirectory: "passed",
				backgroundStartValidation: "passed",
				duplicateStart: "passed",
				backgroundStop: "passed",
				directChildStop: "passed",
				descendantStop: process.platform === "win32" ? "not run on Windows" : "passed",
				backgroundEnvironment: "passed",
				backgroundEnvironmentOverride: "passed",
				separateStreams: "passed",
				mergedInterleavedUtf8: "passed",
				boundedBackgroundTail: "passed",
				incrementalBackgroundOutput: "passed",
				fullLogPathOptIn: "passed",
				privateOwnedLogs: process.platform === "win32" ? "not applicable" : "passed",
				customLogPreserved: "passed",
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
	await handlers.get("session_shutdown")().catch(() => undefined);
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
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: { getSessionId: () => undefined, getSessionFile: () => undefined },
		ui: {
			notify(message, level) {
				localNotifications.push({ message, level });
			},
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
		if (result.content[0].text.includes(expectedText)) return result.content[0].text;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(`Timed out waiting for '${expectedText}' from job '${name}'`);
}

async function waitForOutputMatch(name, expectedPattern) {
	for (let attempt = 0; attempt < 40; attempt++) {
		const result = await requiredTool("pwsh-get-job-output").execute("poll-output", { name });
		if (expectedPattern.test(result.content[0].text)) return result.content[0].text;
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
	await requiredTool("pwsh-remove-job").execute("cleanup", { name });
	startedJobs.delete(name);
}
