// Runs only inside the systemd service created by the extension. The private
// control socket is a lifetime lease, not a PID file that can become stale.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const socket = createConnection(process.argv[2]);
socket.on("error", () => process.exit(137));
socket.on("close", () => process.exit(137));
socket.on("connect", () => socket.write(JSON.stringify({ type: "ready", pid: process.pid }) + "\n"));
let configured = false;
createInterface({ input: socket }).on("line", (line) => {
	try {
		const config = JSON.parse(line);
		if (configured) process.exit(137); // stop, or any invalid second command
		configured = true;
		const child = spawn(config.shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", config.command], {
			cwd: config.cwd,
			env: config.env,
			stdio: ["ignore", "inherit", "inherit"],
		});
		child.once("spawn", () => socket.write(JSON.stringify({ type: "started", pid: child.pid }) + "\n"));
		child.once("error", () => {
			socket.end(JSON.stringify({ type: "error", message: "Workload process start failed" }) + "\n", () => process.exit(1));
		});
		child.once("exit", (code) => {
			// Exiting the service's main process makes systemd terminate the entire
			// cgroup, including children that changed session/process group.
			socket.end(JSON.stringify({ type: "exit", exitCode: code ?? 137 }) + "\n", () => process.exit(code ?? 137));
		});
	} catch {
		socket.end(JSON.stringify({ type: "error", message: "Invalid guardian configuration" }) + "\n", () => process.exit(1));
	}
});
