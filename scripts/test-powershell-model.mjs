#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const timeout = Number(process.env.PI_POWERSHELL_MODEL_TEST_TIMEOUT_MS ?? 300_000);
if (!Number.isFinite(timeout) || timeout <= 0) {
	throw new Error("PI_POWERSHELL_MODEL_TEST_TIMEOUT_MS must be a positive number.");
}
const modelArgs = process.argv.slice(2);
const nonce = randomBytes(8).toString("hex");
const results = [];

results.push(
	runScenario(
		"foreground-unicode-streams",
		["powershell"],
		`This is an integration test. Call powershell exactly once with this exact command: [Console]::Out.WriteLine('stdout-${nonce}-🚀'); [Console]::Error.WriteLine('stderr-${nonce}-雪'). Then briefly report success.`,
		(events) => {
			const calls = requireCalls(events, ["powershell"]);
			assert(calls.length === 1, `expected one powershell call, observed ${calls.length}`);
			const result = completionFor(events, calls[0]);
			assert(!result.isError, "foreground Unicode command failed");
			const text = JSON.stringify(result.result);
			assert(text.includes(`stdout-${nonce}-🚀`), "stdout Unicode marker was missing");
			assert(text.includes(`stderr-${nonce}-雪`), "stderr Unicode marker was missing");
		},
	),
);

results.push(
	runScenario(
		"foreground-truncation",
		["powershell"],
		`This is an integration test. Call powershell exactly once with this exact command: 1..3000 | ForEach-Object { "model-line-$_" }; Write-Output 'tail-${nonce}'. Then briefly report success.`,
		(events) => {
			const calls = requireCalls(events, ["powershell"]);
			assert(calls.length === 1, `expected one powershell call, observed ${calls.length}`);
			const result = completionFor(events, calls[0]);
			assert(!result.isError, "large foreground command failed");
			assert(JSON.stringify(result.result).includes(`tail-${nonce}`), "truncated output lost its tail marker");
			assert(result.result?.details?.truncation?.truncated === true, "Pi did not report foreground truncation");
			assert(Boolean(result.result?.details?.fullOutputPath), "Pi did not expose the full foreground output path");
		},
	),
);

results.push(
	runScenario(
		"foreground-timeout-recovery",
		["powershell"],
		`This is an integration test. First call powershell with command Start-Sleep -Seconds 10 and timeout 0.25; it must time out. After observing that expected error, call powershell again with this exact command: Write-Output 'recovered-${nonce}'. Then briefly report success.`,
		(events) => {
			const calls = requireCalls(events, ["powershell", "powershell"]);
			assert(calls.length === 2, `expected two powershell calls, observed ${calls.length}`);
			const timedOut = completionFor(events, calls[0]);
			const recovered = completionFor(events, calls[1]);
			assert(timedOut.isError && JSON.stringify(timedOut.result).includes("timed out"), "first call did not time out");
			assert(!recovered.isError, "recovery call failed");
			assert(JSON.stringify(recovered.result).includes(`recovered-${nonce}`), "recovery marker was missing");
		},
	),
);

const lifecycleJob = `model-lifecycle-${nonce}`;
results.push(
	runScenario(
		"background-lifecycle",
		["pwsh-start-job", "pwsh-get-job", "pwsh-get-job-output", "pwsh-remove-job"],
		`This is an integration test. Complete every step with the background-job tools: start job ${lifecycleJob} with command Write-Output 'job-${nonce}'; poll it with pwsh-get-job until exited; read its output with pwsh-get-job-output and verify the marker; remove it with pwsh-remove-job. Do not skip any step. Then briefly report success.`,
		(events) => {
			const calls = requireCalls(events, ["pwsh-start-job", "pwsh-get-job", "pwsh-get-job-output", "pwsh-remove-job"]);
			const output = calls.find((call) => call.toolName === "pwsh-get-job-output");
			const removal = calls.find((call) => call.toolName === "pwsh-remove-job");
			assert(JSON.stringify(completionFor(events, output).result).includes(`job-${nonce}`), "background marker was missing");
			assert(!completionFor(events, removal).isError, "background job removal failed");
		},
	),
);

const streamsJob = `model-streams-${nonce}`;
results.push(
	runScenario(
		"background-separated-streams",
		["pwsh-start-job", "pwsh-get-job", "pwsh-get-job-output", "pwsh-remove-job"],
		`This is an integration test. Start job ${streamsJob} with command [Console]::Out.WriteLine('job-stdout-${nonce}'); [Console]::Error.WriteLine('job-stderr-${nonce}'), setting both stdout and stderr to the literal value default so they use separate logs. Poll until exited, read and verify both streams, then remove the job. Do not skip any step. Then briefly report success.`,
		(events) => {
			const calls = requireCalls(events, ["pwsh-start-job", "pwsh-get-job", "pwsh-get-job-output", "pwsh-remove-job"]);
			const start = calls.find((call) => call.toolName === "pwsh-start-job");
			assert(start.args?.stdout === "default" && start.args?.stderr === "default", "model did not request separate logs");
			const output = calls.find((call) => call.toolName === "pwsh-get-job-output");
			const text = JSON.stringify(completionFor(events, output).result);
			assert(text.includes(`job-stdout-${nonce}`), "separate stdout marker was missing");
			assert(text.includes(`job-stderr-${nonce}`), "separate stderr marker was missing");
			const removal = calls.find((call) => call.toolName === "pwsh-remove-job");
			assert(!completionFor(events, removal).isError, "separate-stream job removal failed");
		},
	),
);

console.log(JSON.stringify({ modelIntegration: "passed", scenarios: results }, null, 2));

function runScenario(name, tools, prompt, validate) {
	const result = spawnSync(
		process.execPath,
		[
			cli,
			"--mode",
			"json",
			"--no-session",
			"--approve",
			"--no-extensions",
			"--extension",
			join(repoRoot, "extensions", "powershell.ts"),
			"--no-skills",
			"--no-context-files",
			"--no-builtin-tools",
			"--tools",
			tools.join(","),
			...modelArgs,
			prompt,
		],
		{ cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout },
	);
	if (result.error?.code === "ETIMEDOUT") throw new Error(`${name}: Pi timed out after ${timeout}ms.`);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.stderr.write(result.stderr || result.stdout);
		throw new Error(`${name}: Pi failed. Configure a provider with /login or pass --model provider/model.`);
	}
	const events = result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	try {
		validate(events);
	} catch (error) {
		throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	return { name, status: "passed", calls: toolStarts(events).map((event) => event.toolName) };
}

function toolStarts(events) {
	return events.filter((event) => event.type === "tool_execution_start");
}

function requireCalls(events, requiredNames) {
	const calls = toolStarts(events);
	const names = calls.map((call) => call.toolName);
	for (const name of requiredNames) {
		assert(names.includes(name), `model did not call ${name}; observed ${names.join(", ") || "none"}`);
	}
	return calls;
}

function completionFor(events, call) {
	assert(call, "required tool call was missing");
	const completion = events.find(
		(event) => event.type === "tool_execution_end" && event.toolCallId === call.toolCallId,
	);
	assert(completion, `completion was missing for ${call.toolName}`);
	return completion;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}
