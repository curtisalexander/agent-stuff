#!/usr/bin/env node

import { sleep, withPage } from "./cdp.js";

function parseArgs(argv) {
	const args = [...argv];
	const flags = {};
	const positional = [];
	while (args.length > 0) {
		const token = args.shift();
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const key = token.slice(2);
		if (!["selector", "max-chars", "timeout", "reuse-tab"].includes(key)) throw new Error(`Unknown flag: --${key}`);
		if (key === "reuse-tab") {
			flags[key] = true;
			continue;
		}
		const value = args.shift();
		if (value === undefined) throw new Error(`Missing value for --${key}`);
		flags[key] = value;
	}
	return { flags, positional };
}

function toInt(value, fallback) {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid integer: ${value}`);
	return parsed;
}

function formatPage(data, maxChars) {
	const text = String(data.text || "").trim();
	const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]` : text;
	return [
		`Title: ${data.title || "Untitled"}`,
		`URL: ${data.url}`,
		`Text length: ${text.length}`,
		"",
		truncated || "No text extracted.",
	].join("\n");
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const url = positional[0];
if (!url) {
	console.log("Usage: node scripts/fetch.js <url> [--selector CSS] [--max-chars N] [--timeout MS] [--reuse-tab]");
	process.exit(1);
}

const selector = flags.selector ? String(flags.selector) : null;
const maxChars = Math.max(1000, toInt(flags["max-chars"], 12000));
const timeout = toInt(flags.timeout, 20000);
const reuseTab = flags["reuse-tab"] === true;

const result = await withPage({ createNew: !reuseTab, navigateTo: url, timeout }, async ({ client, sessionId }) => {
	await sleep(1000);
	const expression = [
		"(() => {",
		`const selector = ${JSON.stringify(selector)};`,
		"let root = null;",
		"if (selector) root = document.querySelector(selector);",
		"if (!root) root = document.querySelector('main') || document.querySelector('article') || document.querySelector('[role=main]') || document.body || document.documentElement;",
		"const title = document.title;",
		"const url = location.href;",
		"const clone = root ? root.cloneNode(true) : null;",
		"if (clone) for (const node of clone.querySelectorAll('script, style, noscript, svg, canvas, iframe')) node.remove();",
		"const rawText = String((clone && (clone.innerText || clone.textContent)) || '');",
		"const lines = rawText.split('\\n').map((line) => line.replace(/\\s+/g, ' ').trim()).filter(Boolean);",
		"const text = lines.join('\\n');",
		"return { title, url, text };",
		"})()",
	].join("\n");
	return await client.evaluate(sessionId, expression, timeout);
});

console.log(formatPage(result, maxChars));
