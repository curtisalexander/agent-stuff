#!/usr/bin/env node

import { URL } from "node:url";
import { sleep, withPage } from "./cdp.js";

const DEFAULT_SEARCH_URL_TEMPLATE = process.env.CDP_SEARCH_URL_TEMPLATE || "https://html.duckduckgo.com/html/?q=%s";

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
		if (!["limit", "timeout"].includes(key)) throw new Error(`Unknown flag: --${key}`);
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

function buildSearchUrl(query) {
	return DEFAULT_SEARCH_URL_TEMPLATE.replace("%s", encodeURIComponent(query));
}

function unwrapSearchRedirect(url) {
	try {
		const parsed = new URL(url);
		const redirect = parsed.searchParams.get("uddg") || parsed.searchParams.get("url") || parsed.searchParams.get("u");
		return redirect || url;
	} catch {
		return url;
	}
}

function formatResults(data, limit) {
	const lines = [`Query: ${data.query}`, `Search URL: ${data.searchUrl}`, `Page title: ${data.pageTitle}`, ""];
	const results = Array.isArray(data.results) ? data.results.slice(0, limit) : [];
	if (results.length === 0) {
		lines.push("No search results found.");
		return lines.join("\n");
	}
	for (const [index, result] of results.entries()) {
		lines.push(`${index + 1}. ${result.title || "Untitled"}`);
		lines.push(`URL: ${unwrapSearchRedirect(result.url)}`);
		if (result.snippet) lines.push(`Snippet: ${result.snippet}`);
		lines.push("");
	}
	return lines.join("\n").trim();
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const query = positional.join(" ").trim();
if (!query) {
	console.log("Usage: node scripts/search.js <query> [--limit N] [--timeout MS]");
	process.exit(1);
}

const limit = Math.max(1, Math.min(10, toInt(flags.limit, 5)));
const timeout = toInt(flags.timeout, 20000);
const searchUrl = buildSearchUrl(query);

const result = await withPage({ createNew: true, navigateTo: searchUrl, timeout }, async ({ client, sessionId }) => {
	await sleep(1000);
	const expression = [
		"(() => {",
		`const query = ${JSON.stringify(query)};`,
		"const searchUrl = location.href;",
		"const pageTitle = document.title;",
		"const seen = new Set();",
		"const results = [];",
		"const selectors = [",
		"  '[data-testid=\\\"result\\\"]',",
		"  '.result',",
		"  '.web-result',",
		"  'article',",
		"  'li',",
		"  'div'",
		"];",
		"const candidates = [];",
		"for (const selector of selectors) {",
		"  for (const node of document.querySelectorAll(selector)) candidates.push(node);",
		"}",
		"for (const node of candidates) {",
		"  const anchor = node.querySelector('a[href]') || node.closest('a[href]');",
		"  if (!anchor) continue;",
		"  const href = anchor.href;",
		"  const title = String(anchor.textContent || '').replace(/\\s+/g, ' ').trim();",
		"  if (!href || !(href.startsWith('http://') || href.startsWith('https://'))) continue;",
		"  if (!title || title.length < 3) continue;",
		"  if (seen.has(href)) continue;",
		"  const bad = href.includes('/settings') || href.includes('/search?') || href.includes('/account') || href.includes('/preferences') || href.includes('javascript:');",
		"  if (bad) continue;",
		"  let snippet = String(node.textContent || '').replace(/\\s+/g, ' ').trim();",
		"  if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();",
		"  results.push({ title, url: href, snippet: snippet.slice(0, 280) });",
		"  seen.add(href);",
		"  if (results.length >= 20) break;",
		"}",
		"if (results.length === 0) {",
		"  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {",
		"    const href = anchor.href;",
		"    const title = String(anchor.textContent || '').replace(/\\s+/g, ' ').trim();",
		"    if (!href || !(href.startsWith('http://') || href.startsWith('https://'))) continue;",
		"    if (!title || title.length < 8) continue;",
		"    if (seen.has(href)) continue;",
		"    const node = anchor.closest('article, li, div, section') || anchor.parentElement || document.body;",
		"    let snippet = String(node.textContent || '').replace(/\\s+/g, ' ').trim();",
		"    if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();",
		"    results.push({ title, url: href, snippet: snippet.slice(0, 280) });",
		"    seen.add(href);",
		"    if (results.length >= 20) break;",
		"  }",
		"}",
		"return { query, searchUrl, pageTitle, results };",
		"})()",
	].join("\n");
	return await client.evaluate(sessionId, expression, timeout);
});

console.log(formatResults(result, limit));
