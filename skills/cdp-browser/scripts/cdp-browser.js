#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function usage() {
	console.error(`Usage:
  node scripts/cdp-browser.js start [--profile]
  node scripts/cdp-browser.js search <query> [--limit N] [--timeout MS]
  node scripts/cdp-browser.js fetch <url> [--selector CSS] [--max-chars N] [--timeout MS] [--reuse-tab]
  node scripts/cdp-browser.js nav <url> [--new]
  node scripts/cdp-browser.js eval '<expression>'
  node scripts/cdp-browser.js screenshot`);
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === "help" || command === "--help") {
	usage();
	process.exit(command ? 0 : 1);
}

const commandToScript = {
	start: "start.js",
	search: "search.js",
	fetch: "fetch.js",
	nav: "nav.js",
	eval: "eval.js",
	screenshot: "screenshot.js",
};

const script = commandToScript[command];
if (!script) {
	usage();
	process.exit(1);
}

const child = spawn(process.execPath, [join(__dirname, script), ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
