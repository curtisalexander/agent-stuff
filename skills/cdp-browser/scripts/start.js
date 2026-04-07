#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureBrowserAvailable } from "./cdp.js";

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
	];
	return candidates.find((path) => existsSync(path)) || null;
}

try {
	await ensureBrowserAvailable(1500);
	console.log("✓ Chrome already running with CDP enabled");
	process.exit(0);
} catch {
	// continue and start browser
}

execSync(`mkdir -p ${JSON.stringify(cacheDir)}`);

if (useProfile) {
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

const chromeArgs = [
	"--remote-debugging-port=9222",
	`--user-data-dir=${cacheDir}`,
	"--profile-directory=Default",
	"--disable-search-engine-choice-screen",
	"--no-first-run",
	"--disable-features=ProfilePicker",
	"--no-default-browser-check",
];

const child = spawn(chromeBinary, chromeArgs, { detached: true, stdio: "ignore" });
child.unref();

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
	console.error(`✗ Failed to start Chrome with CDP using ${chromeBinary}`);
	process.exit(1);
}

console.log(`✓ Chrome started with CDP${useProfile ? " using copied profile" : ""}`);
