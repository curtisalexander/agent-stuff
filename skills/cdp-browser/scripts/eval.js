#!/usr/bin/env node

import { connect } from "./cdp.js";

const code = process.argv.slice(2).join(" ").trim();
if (!code) {
	console.log("Usage: node scripts/eval.js '<expression>'");
	process.exit(1);
}

const client = await connect();
try {
	const pages = await client.getPages();
	const page = pages.at(-1);
	if (!page) throw new Error("No active tab found");

	const sessionId = await client.attachToPage(page.targetId);
	await client.enablePage(sessionId);
	const expression = `(async () => (${code}))()`;
	const result = await client.evaluate(sessionId, expression, 30000);

	if (typeof result === "string") console.log(result);
	else console.log(JSON.stringify(result, null, 2));

	await client.detach(sessionId).catch(() => {});
} finally {
	await client.close().catch(() => {});
}
