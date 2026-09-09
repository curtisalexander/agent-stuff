#!/usr/bin/env node

import { fork, spawn, spawnSync } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

if (process.argv[2] === "--descendant") {
	await writeFile(process.argv[3], String(process.pid));
	setInterval(() => {}, 60_000);
} else if (process.argv[2] === "--workload") {
	const [, , , rootMarker, descendantMarker, behavior] = process.argv;
	await writeFile(rootMarker, String(process.pid));
	const descendant = spawn(process.execPath, [scriptPath, "--descendant", descendantMarker], {
		detached: true,
		stdio: "ignore",
	});
	descendant.unref();
	await waitForFile(descendantMarker);
	if (behavior === "exit") process.exit(0);
	setInterval(() => {}, 60_000);
} else if (process.argv[2] === "--owner-worker") {
	const config = JSON.parse(await readFile(process.argv[3], "utf8"));
	const { spawnSupervisedJob } = await loadSupervisor();
	const job = await spawnSupervisedJob(config.job);
	const rootPid = await job.started;
	await writeFile(config.readyMarker, JSON.stringify({ rootPid }));
	setInterval(() => {}, 60_000);
} else {
	let watchdog;
	try {
		await Promise.race([
			runTests(),
			new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("Supervisor crash-test watchdog expired after 90 seconds.")), 90_000); }),
		]);
	} finally {
		clearTimeout(watchdog);
	}
}

async function runTests() {
	if (process.platform !== "linux" && process.platform !== "win32") {
		const { spawnSupervisedJob } = await loadSupervisor();
		await assertRejects(
			spawnSupervisedJob({ shell: "unused", command: "unused", cwd: repoRoot, env: {} }),
			"unsupported platform did not fail closed",
		);
		console.log(`PASS: unsupported ${process.platform} backend fails closed; native crash tests are not applicable.`);
		return;
	}

	const shell = process.env.POWERSHELL_BIN || "pwsh";
	const probe = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { stdio: "ignore" });
	assert(!probe.error && probe.status === 0, `PowerShell prerequisite unavailable at '${shell}'. Install PowerShell 7 before running supervisor tests.`);
	if (process.platform === "linux") {
		const systemd = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" });
		assert(!systemd.error && systemd.status === 0, "Linux prerequisite unavailable: a systemd --user manager and user D-Bus session are required. In the orb run with XDG_RUNTIME_DIR=/run/user/1000.");
	}

	const scratch = await mkdtemp(join(tmpdir(), "pi-pwsh-supervisor-test-"));
	const jobs = new Set();
	const ownedProcesses = new Set();
	const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},60000)"], { stdio: "ignore" });
	ownedProcesses.add(unrelated);
	try {
		const { spawnSupervisedJob } = await loadSupervisor();
		const makeJob = async (command, env = process.env) => {
			const job = await spawnSupervisedJob({ shell, command, cwd: repoRoot, env: { ...env } });
			jobs.add(job);
			return job;
		};

		// The wrapper's exit status must be the workload status, and output must remain attached.
		const normal = await makeJob("[Console]::Out.WriteLine('supervisor-normal-output'); exit 7");
		let stdout = "";
		normal.child.stdout?.on("data", (chunk) => { stdout += chunk; });
		await normal.started;
		assert(await normal.exited === 7, "normal workload exit code 7 was not preserved");
		assert(stdout.trim() === "supervisor-normal-output", `normal workload stdout was not preserved exactly (received ${JSON.stringify(stdout.trim())})`);

		// Cancelling startup must not launch the payload; cancelling a completed
		// start must leave the acknowledged background job alive.
		const cancelledMarker = join(scratch, "cancelled-must-not-run");
		const startupAbort = new AbortController();
		const cancelled = await spawnSupervisedJob({ shell, command: `Set-Content -LiteralPath ${psQuote(cancelledMarker)} -Value bad`, cwd: repoRoot, env: { ...process.env } }, startupAbort.signal);
		jobs.add(cancelled);
		startupAbort.abort();
		await assertRejects(cancelled.started, "cancelled startup was acknowledged");
		await cancelled.stop();
		assert(!(await exists(cancelledMarker)), "startup cancellation launched the payload");
		const lateAbort = new AbortController();
		const acknowledged = await spawnSupervisedJob({ shell, command: "Start-Sleep -Seconds 30", cwd: repoRoot, env: { ...process.env } }, lateAbort.signal);
		jobs.add(acknowledged);
		const acknowledgedPid = await acknowledged.started;
		lateAbort.abort();
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert(isProcessAlive(acknowledgedPid), "late cancellation killed an acknowledged background job");
		await acknowledged.stop();

		// Concurrent stop calls must share safe, idempotent completion.
		const stopRoot = join(scratch, "stop-root");
		const stopDesc = join(scratch, "stop-desc");
		const stoppable = await makeJob(nodeWorkloadCommand(stopRoot, stopDesc, "hold"));
		const stopPid = await stoppable.started;
		const stopDescPid = await readPid(stopDesc);
		await Promise.all([stoppable.stop(), stoppable.stop(), stoppable.stop(), stoppable.stop()]);
		await stoppable.stop();
		await assertTerminated([stopPid, stopDescPid], "concurrent stop");
		assert(isProcessAlive(unrelated.pid), "stopping a supervised job killed an unrelated process");

		// A detached/session-changing descendant must die when its root exits.
		const exitRoot = join(scratch, "exit-root");
		const exitDesc = join(scratch, "exit-desc");
		const rootExit = await makeJob(nodeWorkloadCommand(exitRoot, exitDesc, "exit"));
		await rootExit.started;
		const exitDescPid = await readPid(exitDesc);
		assert(await rootExit.exited === 0, "root-exit workload did not report success");
		await assertTerminated([exitDescPid], "detached descendant after root exit");
		assert(isProcessAlive(unrelated.pid), "root-exit cleanup killed an unrelated process");

		// Killing the extension owner closes its lifetime socket and must clean the native container.
		const ownerRoot = join(scratch, "owner-root");
		const ownerDesc = join(scratch, "owner-desc");
		const ownerReady = join(scratch, "owner-ready");
		const ownerConfig = join(scratch, "owner-config.json");
		await writeFile(ownerConfig, JSON.stringify({
			readyMarker: ownerReady,
			job: { shell, command: nodeWorkloadCommand(ownerRoot, ownerDesc, "hold"), cwd: repoRoot, env: { ...process.env } },
		}));
		const owner = fork(scriptPath, ["--owner-worker", ownerConfig], { cwd: repoRoot, stdio: "ignore" });
		ownedProcesses.add(owner);
		const { rootPid: ownerRootPid } = JSON.parse(await readMarker(ownerReady));
		const ownerDescPid = await readPid(ownerDesc);
		process.kill(owner.pid, "SIGKILL");
		await waitFor(() => !isProcessAlive(owner.pid), "extension owner to exit");
		await assertTerminated([ownerRootPid, ownerDescPid], "extension-owner crash");
		assert(isProcessAlive(unrelated.pid), "extension-owner cleanup killed an unrelated process");

		// Kill the actual guardian, never systemd-run on Linux. Native containment must remain fail-safe.
		const guardianRoot = join(scratch, "guardian-root");
		const guardianDesc = join(scratch, "guardian-desc");
		const guardianJob = await makeJob(nodeWorkloadCommand(guardianRoot, guardianDesc, "hold"));
		const guardianRootPid = await guardianJob.started;
		const guardianDescPid = await readPid(guardianDesc);
		const guardianPid = guardianJob.guardianPid;
		assert(Number.isSafeInteger(guardianPid) && guardianPid > 0, "SupervisedJob.guardianPid was not available after started resolved");
		if (process.platform === "linux") assert(guardianPid !== guardianJob.child.pid, "guardianPid incorrectly identifies systemd-run on Linux");
		process.kill(guardianPid, "SIGKILL");
		await guardianJob.exited;
		await assertTerminated([guardianRootPid, guardianDescPid], "guardian crash");
		assert(isProcessAlive(unrelated.pid), "guardian crash cleanup killed an unrelated process");

		// Startup failure must not execute the payload.
		const sentinel = join(scratch, "must-not-run");
		if (process.platform === "linux") {
			const emptyPath = join(scratch, "empty-path");
			await mkdir(emptyPath);
			const oldPath = process.env.PATH;
			process.env.PATH = emptyPath;
			try {
				const failed = await spawnSupervisedJob({ shell, command: `Set-Content -LiteralPath ${psQuote(sentinel)} -Value bad`, cwd: repoRoot, env: { ...process.env, PATH: oldPath } });
				jobs.add(failed);
				await assertRejects(failed.started, "missing systemd-run unexpectedly started a workload");
				await failed.exited;
			} finally {
				if (oldPath === undefined) delete process.env.PATH;
				else process.env.PATH = oldPath;
			}
		} else {
			const failed = await spawnSupervisedJob({ shell: join(scratch, "missing-guardian-shell.exe"), command: `Set-Content -LiteralPath ${psQuote(sentinel)} -Value bad`, cwd: repoRoot, env: { ...process.env } });
			jobs.add(failed);
			await assertRejects(failed.started, "invalid Windows guardian shell unexpectedly started a workload");
			await failed.exited;
		}
		assert(!(await exists(sentinel)), "startup failure executed the payload sentinel");
		assert(isProcessAlive(unrelated.pid), "startup-failure handling killed an unrelated process");

		console.log(`PASS: ${process.platform} native supervisor crash containment, idempotent stop, exit/output, and fail-closed startup`);
	} finally {
		await Promise.allSettled([...jobs].map((job) => job.stop()));
		for (const child of ownedProcesses) {
			if (child.pid && isProcessAlive(child.pid)) child.kill("SIGKILL");
		}
		await rm(scratch, { recursive: true, force: true });
	}
}

async function loadSupervisor() {
	const jiti = createJiti(import.meta.url);
	return jiti.import(join(repoRoot, "extensions", "powershell", "supervisor.ts"));
}

function nodeWorkloadCommand(rootMarker, descendantMarker, behavior) {
	return `& ${psQuote(process.execPath)} ${psQuote(scriptPath)} '--workload' ${psQuote(rootMarker)} ${psQuote(descendantMarker)} ${psQuote(behavior)}`;
}

function psQuote(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function assertRejects(promise, message) {
	try { await promise; } catch { return; }
	throw new Error(message);
}

async function exists(path) {
	try { await access(path, constants.F_OK); return true; } catch { return false; }
}

async function readMarker(path) {
	await waitFor(() => exists(path), `marker ${path}`);
	return readFile(path, "utf8");
}

async function readPid(path) {
	const value = Number(await readMarker(path));
	assert(Number.isSafeInteger(value) && value > 0, `invalid PID marker at ${path}`);
	return value;
}

async function waitForFile(path) {
	await waitFor(() => exists(path), `marker ${path}`);
}

async function waitFor(predicate, description, timeout = 10_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for ${description}.`);
}

async function assertTerminated(pids, context) {
	await waitFor(() => pids.every((pid) => !isProcessAlive(pid)), `${context} PIDs ${pids.join(", ")} to terminate`);
}

function isProcessAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const closeParen = stat.lastIndexOf(")");
			return closeParen >= 0 && stat.slice(closeParen + 2).split(" ")[0] !== "Z";
		} catch (error) {
			if (error.code === "ENOENT") return false;
			throw error;
		}
	}
	try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
