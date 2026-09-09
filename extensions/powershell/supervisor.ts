import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface SupervisedJob {
	child: ChildProcess;
	readonly guardianPid: number | undefined;
	started: Promise<number>;
	exited: Promise<number>;
	stop(): Promise<void>;
}

interface Configuration {
	shell: string;
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

async function stopService(unit: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Timed out stopping supervised service ${unit}.`));
		}, 8_000);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`Could not stop supervised service ${unit}.`));
		});
	});
}

export async function spawnSupervisedJob(config: Configuration, signal?: AbortSignal): Promise<SupervisedJob> {
	if (signal?.aborted) throw new Error("Supervised job startup aborted.");
	const windows = process.platform === "win32";
	if (!windows && process.platform !== "linux") {
		throw new Error("Supervised PowerShell background jobs require Windows Job Objects or Linux systemd user services. No unsafe fallback is enabled. The foreground powershell tool remains available.");
	}
	const id = randomUUID();
	const pipeName = `pi-pwsh-${id}`;
	const directory = windows ? undefined : await mkdtemp(join(tmpdir(), "pi-pwsh-control-"));
	const endpoint = windows ? `\\\\.\\pipe\\${pipeName}` : join(directory!, "control.sock");
	const server = createServer();
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(endpoint, () => { server.removeListener("error", reject); resolve(); });
		});
	} catch (error) {
		if (directory) await rm(directory, { recursive: true, force: true });
		throw error;
	}
	const unit = `pi-pwsh-${id}.service`;
	const guardian = fileURLToPath(new URL(`../../scripts/powershell-job-${windows ? "windows.ps1" : "linux.mjs"}`, import.meta.url));
	const child = windows
		? spawn(config.shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", guardian, pipeName], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
		: spawn("systemd-run", [
			"--user", "--quiet", "--collect", "--wait", "--pipe", "--service-type=exec", `--unit=${unit}`,
			"--property=KillMode=control-group", "--property=TimeoutStopSec=3s", "--property=SendSIGKILL=yes", "--property=Restart=no",
			// systemd expands $ in ExecStart arguments even without a shell.
			... [process.execPath, guardian, endpoint].map((arg) => arg.replaceAll("$", "$$")),
		], { stdio: ["ignore", "pipe", "pipe"] });
	let socket: Socket | undefined;
	let guardianPid: number | undefined;
	let actualExitCode: number | undefined;
	let error: Error | undefined;
	let stopping: Promise<void> | undefined;
	let stopRequested = false;
	let closed = false;
	let resolveStarted!: (pid: number) => void;
	let rejectStarted!: (error: Error) => void;
	const started = new Promise<number>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
	// The caller attaches output capture before awaiting startup.
	void started.catch(() => {});
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
	const startupTimer = setTimeout(() => {
		error = new Error("Supervised PowerShell startup timed out before workload acknowledgement.");
		rejectStarted(error);
		void stop().catch(() => {}); // caller's cleanup also awaits/retries stop
	}, 20_000);
	const onAbort = () => {
		rejectStarted(new Error("Supervised job startup aborted."));
		void stop().catch(() => {});
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	child.once("error", (cause) => { error = cause; rejectStarted(cause); });
	child.once("close", (code) => {
		closed = true;
		signal?.removeEventListener("abort", onAbort);
		clearTimeout(startupTimer);
		rejectStarted(error ?? new Error(windows
			? "PowerShell Job Object supervision could not start. Check PowerShell 7 and Job Object permissions."
			: "PowerShell supervision could not start. A running systemd user manager and user D-Bus session are required (systemctl --user status)."));
		socket?.destroy();
		server.close();
		const cleanup = directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve();
		void cleanup.finally(() => resolveExit(actualExitCode ?? code ?? 137)).catch(() => {});
	});
	server.on("connection", (connection) => {
		if (socket || closed) { connection.destroy(); return; }
		socket = connection;
		server.close();
		connection.on("error", () => {}); // EOF makes the guardian terminate its workload
		createInterface({ input: connection }).on("line", (line) => {
			try {
				const message = JSON.parse(line);
				if (message.type === "ready" && guardianPid === undefined && Number.isSafeInteger(message.pid)) {
					guardianPid = message.pid;
					if (stopRequested) { connection.destroy(); return; }
					connection.write(JSON.stringify(config) + "\n");
				} else if (message.type === "started" && Number.isSafeInteger(message.pid) && message.pid > 0) {
					clearTimeout(startupTimer);
					signal?.removeEventListener("abort", onAbort);
					resolveStarted(message.pid);
				} else if (message.type === "exit" && Number.isInteger(message.exitCode)) {
					actualExitCode = message.exitCode;
				} else if (message.type === "error") {
					error = new Error(`PowerShell guardian: ${message.message}`);
					rejectStarted(error);
				}
			} catch {
				error = new Error("Invalid PowerShell guardian response.");
				rejectStarted(error);
				connection.destroy();
			}
		});
	});
	function stop(): Promise<void> {
		stopRequested = true;
		return (stopping ??= (async () => {
			if (closed) return;
			socket?.write('{"type":"stop"}\n');
			let timer: NodeJS.Timeout | undefined;
			try {
				const done = await Promise.race([
					exited.then(() => true),
					new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
				]);
				if (!done) {
					if (windows) child.kill("SIGKILL"); // last Job Object handle closes in guardian
					else await stopService(unit);
					await Promise.race([
						exited,
						new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Supervised job ${unit} did not exit after termination.`)), 5_000); }),
					]);
				}
			} finally {
				if (timer) clearTimeout(timer);
			}
		})().catch((error) => { stopping = undefined; throw error; }));
	}
	return { child, get guardianPid() { return guardianPid; }, started, exited, stop };
}
