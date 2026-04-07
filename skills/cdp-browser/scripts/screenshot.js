#!/usr/bin/env node

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./cdp.js";

const client = await connect();
try {
	const pages = await client.getPages();
	const page = pages.at(-1);
	if (!page) throw new Error("No active tab found");

	const sessionId = await client.attachToPage(page.targetId);
	await client.enablePage(sessionId);
	const png = await client.screenshot(sessionId, 15000);
	const dir = await mkdtemp(join(tmpdir(), "pi-cdp-browser-"));
	const file = join(dir, "screenshot.png");
	await writeFile(file, png);
	console.log(file);
	await client.detach(sessionId).catch(() => {});
} finally {
	await client.close().catch(() => {});
}
