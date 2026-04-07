import { isToolCallEventType, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const DEFAULT_SHELL = process.env.POWERSHELL_BIN || "pwsh";
const IS_WINDOWS = process.platform === "win32";

function truncateOutput(text: string): { text: string; truncated: boolean } {
	const normalized = text.replace(/\0/g, "");
	const lines = normalized.split("\n");
	let result = normalized;
	let truncated = false;

	if (lines.length > MAX_OUTPUT_LINES) {
		result = lines.slice(-MAX_OUTPUT_LINES).join("\n");
		truncated = true;
	}

	const bytes = Buffer.byteLength(result, "utf8");
	if (bytes > MAX_OUTPUT_BYTES) {
		const buffer = Buffer.from(result, "utf8");
		result = buffer.subarray(buffer.length - MAX_OUTPUT_BYTES).toString("utf8");
		truncated = true;
	}

	return { text: result, truncated };
}

async function saveFullOutput(stdout: string, stderr: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-powershell-"));
	const file = join(dir, "full-output.txt");
	await writeFile(
		file,
		[`# stdout`, stdout, ``, `# stderr`, stderr].join("\n"),
		"utf8",
	);
	return file;
}

function resolveWorkingDirectory(cwd: string, inputCwd?: string): string {
	if (!inputCwd) return cwd;
	const trimmed = inputCwd.startsWith("@") ? inputCwd.slice(1) : inputCwd;
	return resolve(cwd, trimmed);
}

async function runPowerShell(command: string, cwd: string, timeoutSeconds?: number, signal?: AbortSignal) {
	const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
	const child = spawn(DEFAULT_SHELL, args, {
		cwd,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	let timedOut = false;

	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
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
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", resolve);
		});
		return { stdout, stderr, exitCode: exitCode ?? -1, timedOut };
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
		if (signal) signal.removeEventListener("abort", abortHandler);
	}
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
				reason: "bash is disabled on Windows by the PowerShell extension. Use the powershell tool unless the user explicitly requests bash.",
			};
		}
	});

	pi.registerTool({
		name: "powershell",
		label: "PowerShell",
		description:
			"Run PowerShell commands via pwsh. Useful for Windows-style shell commands, PowerShell pipelines, .ps1 scripts, registry or service inspection, and cross-platform pwsh workflows.",
		promptSnippet: "Run PowerShell commands with pwsh and return stdout/stderr plus exit status.",
		promptGuidelines: [
			"Use this tool instead of bash when the user explicitly asks for PowerShell or when Windows-specific commands are needed.",
			"Prefer this tool for PowerShell syntax such as Get-ChildItem, Select-String, pipelines, or .ps1 scripts.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The PowerShell command to run" }),
			cwd: Type.Optional(Type.String({ description: "Optional working directory, relative to the current project" })),
			timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = resolveWorkingDirectory(ctx.cwd, params.cwd);
			const result = await runPowerShell(params.command, cwd, params.timeout, signal);
			const fullCombined = `${result.stdout}${result.stderr}`;
			const stdoutTrunc = truncateOutput(result.stdout);
			const stderrTrunc = truncateOutput(result.stderr);
			const truncated = stdoutTrunc.truncated || stderrTrunc.truncated;
			const fullOutputPath = truncated ? await saveFullOutput(result.stdout, result.stderr) : undefined;

			const summary = [
				`Command: ${params.command}`,
				`Shell: ${DEFAULT_SHELL}`,
				`Working directory: ${cwd}`,
				`Exit code: ${result.exitCode}`,
				result.timedOut ? `Timed out: yes` : undefined,
				truncated && fullOutputPath ? `Full output saved to: ${fullOutputPath}` : undefined,
			].filter(Boolean);

			const sections = [summary.join("\n")];
			if (stdoutTrunc.text.trim()) sections.push(`stdout:\n${stdoutTrunc.text.trimEnd()}`);
			if (stderrTrunc.text.trim()) sections.push(`stderr:\n${stderrTrunc.text.trimEnd()}`);
			if (!stdoutTrunc.text.trim() && !stderrTrunc.text.trim()) sections.push("(no output)");

			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: {
					command: params.command,
					cwd,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					truncated,
					fullOutputPath,
					stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
					stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
					combinedBytes: Buffer.byteLength(fullCombined, "utf8"),
				},
				isError: result.exitCode !== 0 || result.timedOut,
			};
		},
	});
}
