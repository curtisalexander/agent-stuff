import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATUS_KEY = "agentsview";
const STATE_ENTRY_TYPE = "agentsview-state";
const DEFAULT_TIMEOUT_MS = 8_000;

type StatusMode = "compact" | "tokens" | "daily" | "visual" | "off";

type Money = { microdollars: number };
type MoneyValue = Money | number;

type SessionUsage = {
	session_id: string;
	agent: string;
	project: string;
	total_output_tokens: number;
	peak_context_tokens: number;
	has_token_data: boolean;
	cost?: Money;
	/** AgentsView < 0.40 compatibility. */
	cost_usd?: number;
	has_cost: boolean;
	models?: string[];
	unpriced_models?: string[];
	server_running?: boolean;
};

type SessionDetail = {
	id: string;
	project?: string;
	agent?: string;
	message_count?: number;
	user_message_count?: number;
	health_score?: number;
	health_grade?: string;
	health_score_basis?: string[];
	health_penalties?: Record<string, number>;
	outcome?: string;
	outcome_confidence?: string;
	tool_failure_signal_count?: number;
	tool_retry_count?: number;
	edit_churn_count?: number;
	consecutive_failure_max?: number;
	compaction_count?: number;
	secret_leak_count?: number;
};

type DailyUsage = {
	daily?: Array<{
		date: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		totalCost: MoneyValue;
		modelsUsed?: string[];
		modelBreakdowns?: Array<{
			modelName: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			cost: MoneyValue;
		}>;
	}>;
	totals?: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		totalCost: MoneyValue;
		cacheSavings?: MoneyValue;
	};
	sessionCounts?: {
		total: number;
		byProject?: Record<string, number>;
		byAgent?: Record<string, number>;
	};
};

type PromptBreakdown = {
	timestamp: number;
	systemChars: number;
	userChars: number;
	historyChars: number;
	inputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	estimatedSystemTokens?: number;
	estimatedUserTokens?: number;
	estimatedHistoryTokens?: number;
};

type AgentsViewState = {
	installed: boolean | undefined;
	mode: StatusMode;
	currentSessionFile?: string;
	currentSessionId?: string;
	sessionUsage?: SessionUsage;
	sessionDetail?: SessionDetail;
	dailyUsage?: DailyUsage;
	contextWindow?: number;
	pendingBreakdown?: PromptBreakdown;
	lastBreakdown?: PromptBreakdown;
	lastError?: string;
	refreshing: boolean;
	generation: number;
};

const state: AgentsViewState = {
	installed: undefined,
	mode: "compact",
	refreshing: false,
	generation: 0,
};

let refreshQueue: Promise<void> = Promise.resolve();

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		state.generation++;
		state.mode = "compact";
		state.sessionUsage = undefined;
		state.sessionDetail = undefined;
		state.pendingBreakdown = undefined;
		state.lastBreakdown = undefined;
		state.lastError = undefined;
		restoreState(ctx);
		state.currentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		state.currentSessionId = sessionIdFromFile(state.currentSessionFile);
		state.contextWindow = numberOrUndefined((ctx.model as any)?.contextWindow) ?? state.contextWindow;
		void refresh(ctx, { sync: false });
	});

	pi.on("model_select", async (event, ctx) => {
		state.contextWindow = numberOrUndefined((event.model as any)?.contextWindow) ?? state.contextWindow;
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		state.pendingBreakdown = {
			timestamp: Date.now(),
			systemChars: event.systemPrompt.length,
			userChars: textLength(event.prompt),
			historyChars: 0,
		};
	});

	pi.on("context", async (event) => {
		if (!state.pendingBreakdown) return;
		const totalMessageChars = event.messages.reduce((sum, message) => sum + messageTextLength(message), 0);
		state.pendingBreakdown.historyChars = Math.max(0, totalMessageChars - state.pendingBreakdown.userChars);
	});

	pi.on("message_end", async (event) => {
		if (!state.pendingBreakdown || event.message.role !== "assistant") return;
		const usage = (event.message as any).usage;
		if (!usage) return;
		const cost = usage.cost;
		state.lastBreakdown = estimateBreakdown({
			...state.pendingBreakdown,
			inputTokens: numberOrUndefined(usage.input),
			cacheReadTokens: numberOrUndefined(usage.cacheRead),
			cacheWriteTokens: numberOrUndefined(usage.cacheWrite),
			outputTokens: numberOrUndefined(usage.output),
			costUsd: numberOrUndefined(cost?.total),
		});
		state.pendingBreakdown = undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		void refresh(ctx, { sync: true });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		state.generation++;
		ctx.ui.setStatus(STATUS_KEY, "");
	});

	pi.registerCommand("av", {
		description: "Show concise AgentsView usage for the current Pi session",
		handler: async (_args, ctx) => {
			await refresh(ctx, { sync: false });
			ctx.ui.notify(summaryText(), state.lastError ? "warning" : "info");
		},
	});

	pi.registerCommand("av-detail", {
		description: "Show detailed AgentsView usage for the current Pi session",
		handler: async (_args, ctx) => {
			await refresh(ctx, { sync: false });
			ctx.ui.setWidget(STATUS_KEY, detailLines());
		},
	});

	pi.registerCommand("av-daily", {
		description: "Show today's Pi usage from AgentsView",
		handler: async (_args, ctx) => {
			await refreshDaily(ctx);
			ctx.ui.setWidget(STATUS_KEY, dailyLines());
		},
	});

	pi.registerCommand("av-breakdown", {
		description: "Show estimated system/user/history token attribution for the last turn",
		handler: async (_args, ctx) => {
			ctx.ui.setWidget(STATUS_KEY, breakdownLines());
		},
	});

	pi.registerCommand("av-sync", {
		description: "Force AgentsView to sync the current Pi session and refresh status",
		handler: async (_args, ctx) => {
			await refresh(ctx, { sync: true });
			ctx.ui.notify(summaryText(), state.lastError ? "warning" : "info");
		},
	});

	pi.registerCommand("av-open", {
		description: "Open the AgentsView web app, starting the server if needed",
		handler: async (_args, ctx) => {
			const ok = await ensureInstalled();
			if (!ok) {
				ctx.ui.notify("AgentsView CLI not found. Install with: brew install --cask agentsview", "warning");
				return;
			}
			try {
				await openAgentsView();
				ctx.ui.notify("Opening AgentsView at http://127.0.0.1:8080", "info");
			} catch (error) {
				ctx.ui.notify(`Could not open AgentsView: ${shortError(error)}`, "warning");
			}
		},
	});

	pi.registerCommand("av-statusline", {
		description: "Set AgentsView statusline mode: compact, tokens, daily, visual, off",
		handler: async (args, ctx) => {
			const requested = args.trim() as StatusMode;
			if (["compact", "tokens", "daily", "visual", "off"].includes(requested)) {
				state.mode = requested;
			} else {
				state.mode = nextMode(state.mode);
			}
			pi.appendEntry(STATE_ENTRY_TYPE, { mode: state.mode });
			updateStatus(ctx);
			ctx.ui.notify(`AgentsView statusline: ${state.mode}`, "info");
		},
	});
}

async function refresh(ctx: ExtensionContext, options: { sync: boolean }) {
	const generation = state.generation;
	refreshQueue = refreshQueue.catch(() => undefined).then(() => refreshNow(ctx, options, generation));
	return refreshQueue;
}

async function refreshNow(ctx: ExtensionContext, options: { sync: boolean }, generation: number) {
	if (generation !== state.generation) return;
	state.refreshing = true;
	state.lastError = undefined;
	state.currentSessionFile = ctx.sessionManager.getSessionFile() ?? state.currentSessionFile;
	state.currentSessionId = sessionIdFromFile(state.currentSessionFile) ?? state.currentSessionId;
	updateStatus(ctx, "AV syncing…");

	try {
		const installed = await ensureInstalled();
		if (!installed) {
			state.lastError = "AgentsView CLI not found";
			return;
		}

		if (options.sync && state.currentSessionFile && existsSync(state.currentSessionFile)) {
			await syncCurrentSession(generation).catch((error) => {
				// Keep going: if sync fails because the file maps to multiple sessions, the derived id may still work.
				if (generation === state.generation) state.lastError = shortError(error);
			});
		}

		const results = await Promise.allSettled([
			refreshSessionUsage(generation),
			refreshSessionDetail(generation),
			refreshDaily(ctx, generation),
		]);
		const firstFailure = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
		if (generation === state.generation && firstFailure && !state.lastError) state.lastError = shortError(firstFailure.reason);
	} catch (error) {
		if (generation === state.generation) state.lastError = shortError(error);
	} finally {
		if (generation === state.generation) {
			state.refreshing = false;
			updateStatus(ctx);
		}
	}
}

async function syncCurrentSession(generation = state.generation) {
	const sessionFile = state.currentSessionFile;
	if (!sessionFile || generation !== state.generation) return;
	const stdout = await av(["session", "sync", sessionFile, "--format", "json"], 30_000);
	if (generation !== state.generation) return;
	const detail = JSON.parse(stdout) as SessionDetail;
	if (detail.id) {
		state.currentSessionId = detail.id;
		state.sessionDetail = detail;
	}
}

async function refreshSessionUsage(generation = state.generation) {
	if (generation !== state.generation) return;
	if (!state.currentSessionId && state.currentSessionFile && existsSync(state.currentSessionFile)) {
		await syncCurrentSession(generation);
	}
	if (!state.currentSessionId || generation !== state.generation) return;
	try {
		const stdout = await av(["session", "usage", state.currentSessionId, "--format", "json"]);
		if (generation === state.generation) state.sessionUsage = JSON.parse(stdout) as SessionUsage;
	} catch (error) {
		if (generation === state.generation && state.currentSessionFile && existsSync(state.currentSessionFile)) {
			await syncCurrentSession(generation);
			if (state.currentSessionId && generation === state.generation) {
				const stdout = await av(["session", "usage", state.currentSessionId, "--format", "json"]);
				if (generation === state.generation) state.sessionUsage = JSON.parse(stdout) as SessionUsage;
				return;
			}
		}
		throw error;
	}
}

async function refreshSessionDetail(generation = state.generation) {
	if (!state.currentSessionId || generation !== state.generation) return;
	const stdout = await av(["session", "get", state.currentSessionId, "--format", "json"]);
	if (generation === state.generation) state.sessionDetail = JSON.parse(stdout) as SessionDetail;
}

async function refreshDaily(_ctx: ExtensionContext, generation = state.generation) {
	const today = new Date().toISOString().slice(0, 10);
	const stdout = await av(["usage", "daily", "--json", "--agent", "pi", "--since", today, "--no-sync"]);
	if (generation === state.generation) state.dailyUsage = JSON.parse(stdout) as DailyUsage;
}

async function ensureInstalled() {
	if (state.installed !== undefined) return state.installed;
	try {
		await av(["version"], 3_000);
		state.installed = true;
	} catch {
		state.installed = false;
	}
	return state.installed;
}

async function av(args: string[], timeout = DEFAULT_TIMEOUT_MS) {
	const { stdout } = await execFileAsync("agentsview", args, {
		timeout,
		maxBuffer: 1024 * 1024,
	});
	return stdout.trim();
}

function restoreState(ctx: ExtensionContext) {
	for (const entry of ctx.sessionManager.getEntries()) {
		if ((entry as any).type !== "custom" || (entry as any).customType !== STATE_ENTRY_TYPE) continue;
		const mode = (entry as any).data?.mode;
		if (["compact", "tokens", "daily", "visual", "off"].includes(mode)) state.mode = mode;
	}
}

function updateStatus(ctx: ExtensionContext, override?: string) {
	if (state.mode === "off") {
		ctx.ui.setStatus(STATUS_KEY, "");
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, override ?? formatStatus());
}

function formatStatus() {
	if (state.installed === false) return "AV not installed";
	if (state.lastError && !state.sessionUsage && !state.dailyUsage) return "AV error";

	const session = state.sessionUsage;
	const daily = state.dailyUsage?.totals;
	if (!session && !daily) return "AV no data";

	if (state.mode === "daily") {
		return `AV ${money(daily?.totalCost)} today · in ${compact(daily?.inputTokens)} · out ${compact(daily?.outputTokens)}`;
	}

	if (state.mode === "visual") {
		return formatVisualStatus();
	}

	if (state.mode === "tokens") {
		return `AV ${money(sessionCost(session))} · out ${compact(session?.total_output_tokens)} · peak ${compact(session?.peak_context_tokens)} ctx`;
	}

	const warning = session?.has_cost === false ? " · unpriced" : "";
	const health = state.sessionDetail?.health_grade ? ` · ${state.sessionDetail.health_grade}` : "";
	return `AV ${money(sessionCost(session))} sess · ${money(daily?.totalCost)} today · ${compact(session?.peak_context_tokens)} ctx${health}${warning}`;
}

function summaryText() {
	if (state.lastError) return `AgentsView: ${state.lastError}`;
	return formatStatus();
}

function detailLines() {
	const usage = state.sessionUsage;
	if (!usage) return [summaryText()];
	return [
		"AgentsView current session",
		`Session: ${usage.session_id}`,
		`Project: ${usage.project}`,
		`Cost: ${usage.has_cost ? money(sessionCost(usage)) : "n/a"}`,
		`Output tokens: ${usage.total_output_tokens.toLocaleString()}`,
		`Peak context: ${usage.peak_context_tokens.toLocaleString()}`,
		`Models: ${(usage.models ?? []).join(", ") || "n/a"}`,
		`Unpriced: ${(usage.unpriced_models ?? []).join(", ") || "none"}`,
		...healthLines(),
		`Source: ${usage.server_running ? "AgentsView server" : "local DB"}`,
		state.lastBreakdown ? `Last turn est: ${breakdownSummary(state.lastBreakdown)}` : "",
		state.lastError ? `Last warning: ${state.lastError}` : "",
	].filter(Boolean);
}

function healthLines() {
	const detail = state.sessionDetail;
	if (!detail) return [];
	const lines = [
		`Health: ${detail.health_grade ?? "?"}${detail.health_score !== undefined ? ` (${detail.health_score})` : ""}`,
		`Outcome: ${detail.outcome ?? "unknown"}${detail.outcome_confidence ? ` (${detail.outcome_confidence})` : ""}`,
		`Messages: ${detail.message_count ?? "?"} · user ${detail.user_message_count ?? "?"}`,
	];
	if (detail.tool_retry_count || detail.tool_failure_signal_count || detail.secret_leak_count) {
		lines.push(`Signals: retries ${detail.tool_retry_count ?? 0} · failures ${detail.tool_failure_signal_count ?? 0} · secrets ${detail.secret_leak_count ?? 0}`);
	}
	if (detail.health_score_basis?.length) lines.push(`Basis: ${detail.health_score_basis.join(", ")}`);
	return lines;
}

function dailyLines() {
	const usage = state.dailyUsage;
	const today = usage?.daily?.[usage.daily.length - 1];
	if (!usage?.totals) return [summaryText()];
	const lines = [
		"AgentsView Pi usage today",
		`Cost: ${money(usage.totals.totalCost)}`,
		`Mix: ${tokenSparkline(usage.totals)} in/cache/out`,
		`Cache: ${cachePercent(usage.totals)}% of input-side tokens`,
		`Input: ${usage.totals.inputTokens.toLocaleString()}`,
		`Output: ${usage.totals.outputTokens.toLocaleString()}`,
		`Cache read: ${usage.totals.cacheReadTokens.toLocaleString()}`,
		`Cache write: ${usage.totals.cacheCreationTokens.toLocaleString()}`,
		`Cache savings: ${money(usage.totals.cacheSavings)}`,
		`Sessions: ${usage.sessionCounts?.total ?? 0}`,
	];
	for (const model of today?.modelBreakdowns ?? []) {
		lines.push(`- ${model.modelName}: ${money(model.cost)} · in ${compact(model.inputTokens)} · out ${compact(model.outputTokens)}`);
	}
	return lines;
}

function breakdownLines() {
	const breakdown = state.lastBreakdown;
	if (!breakdown) {
		return [
			"AgentsView prompt attribution",
			"No completed turn captured yet.",
			"This is an experimental estimate based on character share before the provider request.",
		];
	}
	return [
		"AgentsView prompt attribution (estimated)",
		`Input mix: ${breakdownSparkline(breakdown)} system/user/history`,
		`System: ${compact(breakdown.estimatedSystemTokens)} tokens (${breakdown.systemChars.toLocaleString()} chars)`,
		`User: ${compact(breakdown.estimatedUserTokens)} tokens (${breakdown.userChars.toLocaleString()} chars)`,
		`History/tools: ${compact(breakdown.estimatedHistoryTokens)} tokens (${breakdown.historyChars.toLocaleString()} chars)`,
		`Cache read/write: ${compact(breakdown.cacheReadTokens)} / ${compact(breakdown.cacheWriteTokens)}`,
		`Output: ${compact(breakdown.outputTokens)} tokens`,
		`Cost: ${money(breakdown.costUsd)}`,
		"Note: provider usage is exact, category split is approximate.",
	];
}

function breakdownSummary(breakdown: PromptBreakdown) {
	return `${breakdownSparkline(breakdown)} sys/user/hist`;
}

function breakdownSparkline(breakdown: PromptBreakdown) {
	return sparkline([
		breakdown.estimatedSystemTokens ?? 0,
		breakdown.estimatedUserTokens ?? 0,
		breakdown.estimatedHistoryTokens ?? 0,
	]);
}

function estimateBreakdown(breakdown: PromptBreakdown): PromptBreakdown {
	const inputSideTokens = (breakdown.inputTokens ?? 0) + (breakdown.cacheReadTokens ?? 0) + (breakdown.cacheWriteTokens ?? 0);
	const totalChars = breakdown.systemChars + breakdown.userChars + breakdown.historyChars;
	if (!inputSideTokens || !totalChars) return breakdown;
	return {
		...breakdown,
		estimatedSystemTokens: Math.round(inputSideTokens * (breakdown.systemChars / totalChars)),
		estimatedUserTokens: Math.round(inputSideTokens * (breakdown.userChars / totalChars)),
		estimatedHistoryTokens: Math.round(inputSideTokens * (breakdown.historyChars / totalChars)),
	};
}

function sessionIdFromFile(file: string | undefined) {
	if (!file) return undefined;
	const match = basename(file).match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
	return match ? `pi:${match[1]}` : undefined;
}

async function openAgentsView() {
	const url = "http://127.0.0.1:8080";
	if (!(await agentsViewServerReady(url))) {
		const server = spawn("agentsview", ["serve", "--no-browser"], { detached: true, stdio: "ignore" });
		await waitForSpawn(server, "AgentsView server");
		server.unref();
		for (let attempt = 0; attempt < 20 && !(await agentsViewServerReady(url)); attempt++) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
		}
		if (!(await agentsViewServerReady(url))) throw new Error("server did not become ready");
	}

	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
	const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
	const child = spawn(opener, args, { detached: true, stdio: "ignore" });
	await waitForSpawn(child, "browser opener");
	child.unref();
}

async function agentsViewServerReady(url: string) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(750) });
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForSpawn(child: ReturnType<typeof spawn>, label: string) {
	await new Promise<void>((resolveSpawn, rejectSpawn) => {
		const onSpawn = () => {
			child.removeListener("error", onError);
			resolveSpawn();
		};
		const onError = (error: Error) => {
			child.removeListener("spawn", onSpawn);
			rejectSpawn(new Error(`${label} failed: ${error.message}`));
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}

function formatVisualStatus() {
	const totals = state.dailyUsage?.totals;
	const session = state.sessionUsage;
	if (!totals) return "AV no data";
	const health = state.sessionDetail?.health_grade ? ` · ${state.sessionDetail.health_grade}` : "";
	return `AV ${money(totals.totalCost)} · ${tokenSparkline(totals)} in/cache/out · cache ${cachePercent(totals)}% · ctx ${contextGauge(session?.peak_context_tokens)}${health}`;
}

function tokenSparkline(totals: NonNullable<DailyUsage["totals"]>) {
	const cacheTokens = totals.cacheReadTokens + totals.cacheCreationTokens;
	return sparkline([totals.inputTokens, cacheTokens, totals.outputTokens]);
}

function sparkline(values: number[]) {
	const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const max = Math.max(...values, 0);
	if (!max) return "▁▁▁";
	return values
		.map((value) => {
			if (value <= 0) return "▁";
			const index = Math.max(0, Math.min(blocks.length - 1, Math.ceil((value / max) * blocks.length) - 1));
			return blocks[index];
		})
		.join("");
}

function cachePercent(totals: NonNullable<DailyUsage["totals"]>) {
	const cacheTokens = totals.cacheReadTokens + totals.cacheCreationTokens;
	const inputSide = totals.inputTokens + cacheTokens;
	if (!inputSide) return 0;
	return Math.round((cacheTokens / inputSide) * 100);
}

function contextGauge(peakContextTokens: number | undefined) {
	if (!peakContextTokens) return "▁ 0";
	if (!state.contextWindow) return `${compact(peakContextTokens)}`;
	const pct = Math.max(0, Math.min(1, peakContextTokens / state.contextWindow));
	return `${blockForRatio(pct)} ${compact(peakContextTokens)}/${compact(state.contextWindow)}`;
}

function blockForRatio(ratio: number) {
	const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	if (ratio <= 0) return blocks[0];
	const index = Math.max(0, Math.min(blocks.length - 1, Math.ceil(ratio * blocks.length) - 1));
	return blocks[index];
}

function nextMode(mode: StatusMode): StatusMode {
	if (mode === "compact") return "tokens";
	if (mode === "tokens") return "daily";
	if (mode === "daily") return "visual";
	if (mode === "visual") return "off";
	return "compact";
}

function sessionCost(usage: SessionUsage | undefined) {
	return usage?.cost ?? usage?.cost_usd;
}

function money(value: MoneyValue | undefined) {
	const dollars = typeof value === "number" ? value : value?.microdollars !== undefined ? value.microdollars / 1_000_000 : undefined;
	if (dollars === undefined || !Number.isFinite(dollars)) return "$0.00";
	return `$${dollars.toFixed(dollars < 1 ? 3 : 2)}`;
}

function compact(value: number | undefined) {
	if (!value) return "0";
	if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
	return String(value);
}

function textLength(text: unknown) {
	return typeof text === "string" ? text.length : JSON.stringify(text ?? "").length;
}

function messageTextLength(message: unknown) {
	const content = (message as any)?.content;
	if (typeof content === "string") return content.length;
	if (Array.isArray(content)) {
		return content.reduce((sum, part) => sum + textLength((part as any)?.text ?? (part as any)?.content ?? part), 0);
	}
	return textLength(content);
}

function numberOrUndefined(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shortError(error: unknown) {
	if (error instanceof Error) return error.message.split("\n")[0].slice(0, 160);
	return String(error).slice(0, 160);
}
