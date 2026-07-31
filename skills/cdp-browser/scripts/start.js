#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BROWSER_URL, ensureBrowserAvailable } from "./cdp.js";

const args = new Set(process.argv.slice(2));
const useProfile = args.has("--profile");

const unknownArgs = [...args].filter((arg) => arg !== "--profile");
if (unknownArgs.length > 0) {
	console.log("Usage: node scripts/start.js [--profile]");
	process.exit(1);
}

const cacheDir = join(homedir(), ".cache", "pi-cdp-browser");

function resolveChromeBinary() {
	if (process.env.BROWSER_BIN && existsSync(process.env.BROWSER_BIN)) return process.env.BROWSER_BIN;
	const candidates = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/microsoft-edge",
		process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
		process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
	];
	return candidates.find((path) => path && existsSync(path)) || null;
}

try {
	await ensureBrowserAvailable(1500);
	console.log("✓ Chrome already running with CDP enabled");
	process.exit(0);
} catch {
	// continue and start browser
}

mkdirSync(cacheDir, { recursive: true });

if (useProfile) {
	if (process.platform !== "darwin") {
		console.error("✗ --profile currently supports Google Chrome on macOS only");
		process.exit(1);
	}
	const source = join(homedir(), "Library", "Application Support", "Google", "Chrome") + "/";
	execSync(
		`rsync -a --delete --exclude 'Singleton*' --exclude 'DevToolsActivePort*' ${JSON.stringify(source)} ${JSON.stringify(cacheDir + "/")}`,
		{ stdio: "ignore" },
	);
}

for (const staleFile of ["SingletonCookie", "SingletonLock", "SingletonSocket", "DevToolsActivePort", "DevToolsActivePort.lock"]) {
	rmSync(join(cacheDir, staleFile), { force: true });
}

const chromeBinary = resolveChromeBinary();
if (!chromeBinary) {
	console.error("✗ Could not find Chrome/Chromium. Set BROWSER_BIN=/path/to/chrome");
	process.exit(1);
}

const endpoint = new URL(DEFAULT_BROWSER_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.protocol !== "http:") {
	console.error(`✗ CDP_BROWSER_URL must be a loopback HTTP URL, got ${DEFAULT_BROWSER_URL}`);
	process.exit(1);
}
const debuggingPort = endpoint.port || "9222";

const chromeArgs = [
	`--remote-debugging-port=${debuggingPort}`,
	`--user-data-dir=${cacheDir}`,
	"--profile-directory=Default",
	"--disable-search-engine-choice-screen",
	"--no-first-run",
	"--disable-features=ProfilePicker",
	"--no-default-browser-check",
];

const child = spawn(chromeBinary, chromeArgs, { detached: true, stdio: "ignore" });
try {
	await new Promise((resolveSpawn, rejectSpawn) => {
		child.once("spawn", resolveSpawn);
		child.once("error", rejectSpawn);
	});
} catch (error) {
	console.error(`✗ Failed to launch ${chromeBinary}: ${error.message}`);
	process.exit(1);
}

let ready = false;
for (let i = 0; i < 30; i++) {
	try {
		await ensureBrowserAvailable(1000);
		ready = true;
		break;
	} catch {
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

if (!ready) {
	if (child.pid) {
		if (process.platform === "win32") {
			const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
			killer.on("error", () => {});
		} else {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				// Process already exited.
			}
		}
	}
	console.error(`✗ Failed to start Chrome with CDP using ${chromeBinary}`);
	process.exit(1);
}

child.unref();
console.log(`✓ Chrome started with CDP${useProfile ? " using copied profile" : ""}`);
