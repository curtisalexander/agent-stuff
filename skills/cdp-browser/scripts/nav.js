#!/usr/bin/env node

import { connect } from "./cdp.js";

const args = process.argv.slice(2);
const url = args.find((arg) => !arg.startsWith("--"));
const newTab = args.includes("--new");

if (!url) {
	console.log("Usage: node scripts/nav.js <url> [--new]");
	process.exit(1);
}

const client = await connect();
try {
	let targetId;
	let created = false;
	if (newTab) {
		targetId = await client.createPage("about:blank");
		created = true;
	} else {
		const pages = await client.getPages();
		const page = pages.at(-1);
		if (!page) throw new Error("No active tab found");
		targetId = page.targetId;
	}

	const sessionId = await client.attachToPage(targetId);
	await client.enablePage(sessionId);
	await client.navigateAndWait(sessionId, url, 30000);
	console.log(created ? `✓ Opened: ${url}` : `✓ Navigated to: ${url}`);
	await client.detach(sessionId).catch(() => {});
} finally {
	await client.close().catch(() => {});
}
