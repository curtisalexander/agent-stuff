#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shell = process.env.POWERSHELL_BIN || "pwsh";
const version = spawnSync(shell, ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
	encoding: "utf8",
});
if (version.error || version.status !== 0) {
	throw new Error(`PowerShell is unavailable at '${shell}'. Run: npm run setup:powershell`);
}

const tools = new Map();
const handlers = new Map();
const pi = {
	on(event, handler) {
		handlers.set(event, handler);
	},
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
	getActiveTools() {
		return ["bash"];
	},
	setActiveTools() {},
};

const jiti = createJiti(import.meta.url);
const { default: extension } = await jiti.import(join(repoRoot, "extensions", "powershell.ts"));
extension(pi);

const ctx = {
	cwd: repoRoot,
	model: { provider: "openai", id: "powershell-test-model" },
	thinkingLevel: "medium",
	sessionManager: {
		getSessionId: () => "powershell-test-session",
		getSessionFile: () => undefined,
	},
};

const foreground = requiredTool("powershell");
const startedJobs = new Set();
const scratchDir = await mkdtemp(join(tmpdir(), "pi-powershell-test-"));
let fullOutputPath;

try {
	let streamingUpdates = 0;
	const success = await foreground.execute(
		"success",
		{
			command:
				'Write-Output ("hello-" + $env:PI_SESSION_ID); [Console]::Error.WriteLine("warning-stream")',
		},
		undefined,
		() => streamingUpdates++,
		ctx,
	);
	const successText = success.content[0].text;
	assert(successText.includes("hello-powershell-test-session"), "PI_SESSION_ID was not exposed");
	assert(successText.includes("warning-stream"), "stderr was not captured");
	assert(streamingUpdates > 0, "streaming updates were not emitted");

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
			{ command: "Start-Sleep -Seconds 10", timeout: 0.25 },
			undefined,
			undefined,
			ctx,
		);
	} catch (error) {
		timeoutError = String(error);
	}
	const timeoutMs = Date.now() - timeoutStartedAt;
	assert(timeoutError.includes("timed out") && timeoutMs < 7_000, "timeout or process-tree termination failed");

	const abortController = new AbortController();
	setTimeout(() => abortController.abort(), 250);
	let abortError = "";
	try {
		await foreground.execute(
			"abort",
			{ command: "Start-Sleep -Seconds 10" },
			abortController.signal,
			undefined,
			ctx,
		);
	} catch (error) {
		abortError = String(error);
	}
	assert(abortError.includes("aborted"), "abort handling failed");

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

	const completedJob = `complete-${process.pid}`;
	startedJobs.add(completedJob);
	await requiredTool("pwsh-start-job").execute(
		"job-start",
		{
			name: completedJob,
			command: "Write-Output job-started; Start-Sleep -Milliseconds 300; Write-Output job-finished",
		},
		undefined,
		undefined,
		ctx,
	);
	const completedStatus = await waitForJob(completedJob, "exited");
	const completedOutput = await requiredTool("pwsh-get-job-output").execute(
		"job-output",
		{ name: completedJob },
	);
	assert(completedStatus.includes("Exit code: 0"), "completed background job had the wrong status");
	assert(completedOutput.content[0].text.includes("job-finished"), "background job output was incomplete");
	await removeJob(completedJob);

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
	await removeJob(customLogJob);
	assert(existsSync(customLog), "removing a job deleted its caller-owned log");

	console.log(
		JSON.stringify(
			{
				powershellVersion: version.stdout.trim(),
				foreground: "passed",
				streamingUpdates,
				nonzeroExit: "passed",
				timeoutMs,
				abort: "passed",
				truncation: "passed",
				backgroundComplete: "passed",
				backgroundStop: "passed",
				customLogPreserved: "passed",
			},
			null,
			2,
		),
	);
} finally {
	for (const name of startedJobs) {
		await removeJob(name).catch(() => undefined);
	}
	if (fullOutputPath) await rm(fullOutputPath, { force: true }).catch(() => undefined);
	await rm(scratchDir, { recursive: true, force: true });
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
		if (result.content[0].text.includes(expectedText)) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 250));
	}
	throw new Error(`Timed out waiting for '${expectedText}' from job '${name}'`);
}

async function removeJob(name) {
	if (!startedJobs.has(name)) return;
	await requiredTool("pwsh-remove-job").execute("cleanup", { name });
	startedJobs.delete(name);
}
