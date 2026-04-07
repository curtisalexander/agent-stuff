#!/usr/bin/env node

import WebSocket from "ws";

export const DEFAULT_BROWSER_URL = process.env.CDP_BROWSER_URL || "http://127.0.0.1:9222";

export async function getJson(path, { timeout = 5000 } = {}) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);
	try {
		const response = await fetch(`${DEFAULT_BROWSER_URL}${path}`, { signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
		return await response.json();
	} catch (error) {
		if (error?.name === "AbortError") {
			throw new Error(`Timed out connecting to CDP endpoint at ${DEFAULT_BROWSER_URL}`);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function getText(path, { timeout = 5000, method } = {}) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);
	try {
		const response = await fetch(`${DEFAULT_BROWSER_URL}${path}`, { signal: controller.signal, method });
		if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
		return await response.text();
	} catch (error) {
		if (error?.name === "AbortError") {
			throw new Error(`Timed out connecting to CDP endpoint at ${DEFAULT_BROWSER_URL}`);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function ensureBrowserAvailable(timeout = 5000) {
	try {
		return await getJson("/json/version", { timeout });
	} catch (error) {
		throw new Error(
			`Could not reach Chrome DevTools Protocol at ${DEFAULT_BROWSER_URL}. Start Chrome with --remote-debugging-port=9222. Original error: ${error.message}`,
		);
	}
}

export class CDPClient {
	constructor(wsUrl) {
		this.wsUrl = wsUrl;
		this.ws = null;
		this.nextId = 1;
		this.pending = new Map();
		this.eventHandlers = new Map();
		this.closed = false;
	}

	async connect(timeout = 5000) {
		this.ws = new WebSocket(this.wsUrl);
		await new Promise((resolve, reject) => {
			const connectTimeout = setTimeout(() => {
				this.ws.close();
				reject(new Error("WebSocket connect timeout"));
			}, timeout);

			const onOpen = () => {
				clearTimeout(connectTimeout);
				cleanup();
				resolve();
			};
			const onError = (error) => {
				clearTimeout(connectTimeout);
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			};
			const cleanup = () => {
				this.ws.off("open", onOpen);
				this.ws.off("error", onError);
			};

			this.ws.on("open", onOpen);
			this.ws.on("error", onError);
		});

		this.ws.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			if (message.id) {
				const pending = this.pending.get(message.id);
				if (!pending) return;
				this.pending.delete(message.id);
				if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
				else pending.resolve(message.result);
				return;
			}
			if (message.method) this.emit(message.method, message.params || {}, message.sessionId || null);
		});

		this.ws.on("close", () => {
			this.closed = true;
			for (const pending of this.pending.values()) pending.reject(new Error("CDP websocket closed"));
			this.pending.clear();
		});
	}

	on(method, handler) {
		if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
		this.eventHandlers.get(method).add(handler);
		return () => this.off(method, handler);
	}

	off(method, handler) {
		const handlers = this.eventHandlers.get(method);
		if (!handlers) return;
		handlers.delete(handler);
		if (handlers.size === 0) this.eventHandlers.delete(method);
	}

	emit(method, params, sessionId) {
		const handlers = this.eventHandlers.get(method);
		if (!handlers) return;
		for (const handler of handlers) {
			try {
				handler(params, sessionId);
			} catch {
				// Ignore handler errors to keep the session alive.
			}
		}
	}

	send(method, params = {}, sessionId = null, timeout = 10000) {
		if (!this.ws || this.closed) throw new Error("CDP websocket is not connected");
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			const payload = { id, method, params };
			if (sessionId) payload.sessionId = sessionId;

			const timeoutId = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP timeout: ${method}`));
			}, timeout);

			this.pending.set(id, {
				resolve: (result) => {
					clearTimeout(timeoutId);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timeoutId);
					reject(error);
				},
			});

			this.ws.send(JSON.stringify(payload));
		});
	}

	async getPages() {
		const { targetInfos } = await this.send("Target.getTargets");
		return targetInfos.filter((target) => target.type === "page");
	}

	async createPage(url = "about:blank") {
		const { targetId } = await this.send("Target.createTarget", { url });
		return targetId;
	}

	async attachToPage(targetId) {
		const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
		return sessionId;
	}

	async detach(sessionId) {
		try {
			await this.send("Target.detachFromTarget", { sessionId });
		} catch {
			// ignore
		}
	}

	async closeTarget(targetId) {
		try {
			await getText(`/json/close/${encodeURIComponent(targetId)}`);
		} catch {
			// ignore
		}
	}

	async enablePage(sessionId) {
		await this.send("Page.enable", {}, sessionId);
		await this.send("Runtime.enable", {}, sessionId);
	}

	async navigate(sessionId, url, timeout = 30000) {
		await this.send("Page.navigate", { url }, sessionId, timeout);
	}

	async waitForLoad(sessionId, timeout = 20000) {
		await new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for page load after ${timeout}ms`));
			}, timeout);
			const unsubLoad = this.on("Page.loadEventFired", (_params, eventSessionId) => {
				if (eventSessionId === sessionId) done();
			});
			const unsubStop = this.on("Page.frameStoppedLoading", (_params, eventSessionId) => {
				if (eventSessionId === sessionId) done();
			});
			function cleanup() {
				clearTimeout(timeoutId);
				unsubLoad();
				unsubStop();
			}
			function done() {
				cleanup();
				resolve();
			}
		});
	}

	async evaluate(sessionId, expression, timeout = 30000) {
		const result = await this.send(
			"Runtime.evaluate",
			{ expression, returnByValue: true, awaitPromise: true },
			sessionId,
			timeout,
		);
		if (result.exceptionDetails) {
			const details = result.exceptionDetails;
			throw new Error(details.exception?.description || details.exception?.value || details.text || "Evaluation failed");
		}
		return result.result?.value;
	}

	async screenshot(sessionId, timeout = 10000) {
		const { data } = await this.send("Page.captureScreenshot", { format: "png" }, sessionId, timeout);
		return Buffer.from(data, "base64");
	}

	async close() {
		if (!this.ws || this.closed) return;
		await new Promise((resolve) => {
			this.ws.once("close", resolve);
			this.ws.close();
		});
	}
}

export async function connect(timeout = 5000) {
	const version = await ensureBrowserAvailable(timeout);
	const client = new CDPClient(version.webSocketDebuggerUrl);
	await client.connect(timeout);
	return client;
}

export async function withPage(options, fn) {
	const { createNew = true, navigateTo, timeout = 20000 } = options || {};
	const client = await connect(timeout);
	let targetId;
	let sessionId;
	let created = false;
	try {
		if (createNew) {
			targetId = await client.createPage("about:blank");
			created = true;
		} else {
			const pages = await client.getPages();
			const page = pages.at(-1);
			if (!page) throw new Error("No active tab found");
			targetId = page.targetId;
		}
		sessionId = await client.attachToPage(targetId);
		await client.enablePage(sessionId);
		if (navigateTo) {
			await client.navigate(sessionId, navigateTo, timeout);
			await client.waitForLoad(sessionId, timeout);
		}
		return await fn({ client, sessionId, targetId });
	} finally {
		if (sessionId) await client.detach(sessionId).catch(() => {});
		if (created && targetId) await client.closeTarget(targetId).catch(() => {});
		await client.close().catch(() => {});
	}
}

export async function sleep(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
