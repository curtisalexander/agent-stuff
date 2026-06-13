# AgentsView Pi Extension Plan

## Goal

Create an experimental Pi extension that surfaces AgentsView token and spend analytics directly in Pi's footer/status area, with slash commands for current-session details, daily spend, sync, and opening the AgentsView app.

Pi already shows per-request estimated cost. AgentsView can complement that with indexed, session-aware and day-aware usage across Pi sessions.

## AgentsView findings

AgentsView is local-first and supports Pi sessions out of the box.

Relevant facts:

- Pi sessions are discovered from `PI_DIR`, defaulting to `~/.pi/agent/sessions`.
- AgentsView stores data in `~/.agentsview/sessions.db` and serves a local app/API with `agentsview serve`.
- The desktop app and CLI share the same data directory.
- The CLI is designed as a stable programmatic surface; JSON fields are additive-only.
- Session usage is also available through `GET /api/v1/sessions/{id}/usage` when the server is running.

Useful commands:

```bash
agentsview usage statusline
agentsview usage daily --json --agent pi
agentsview session list --agent pi --format json
agentsview session sync <path-or-id>
agentsview session usage <session-id> --format json
agentsview serve
```

For Pi, AgentsView session ids appear to be derivable from the Pi JSONL filename UUID as:

```text
pi:<uuid>
```

Example:

```text
~/.pi/agent/sessions/.../2026-06-13T15-58-51-344Z_019ec1b5-17d0-7133-a600-3c31d8ed75e0.jsonl
=> pi:019ec1b5-17d0-7133-a600-3c31d8ed75e0
```

## Statusline design

Default compact status:

```text
AV $0.42 sess · $3.18 today · 91k ctx · A
```

Why this is useful:

- `sess` distinguishes indexed current-session cost from Pi's per-turn/request estimate.
- `today` gives broader daily Pi spend.
- `ctx` exposes peak context pressure, which is actionable for long Pi sessions. In visual mode, it becomes a small gauge when the active model context window is known.
- health grade from AgentsView provides a compact quality/signal indicator.

Other possible modes:

```text
AV $0.42 sess · $3.18 today
AV $0.42 · out 18.2k · peak 91k
AV $0.42 · peak 91k · unpriced: 1
AV $2.89 · ▂█▁ in/cache/out · cache 85% · ctx ▄ 56k/128k
AV off
```

Unicode visual legend:

- first block = paid input tokens
- second block = cache tokens, cache read + cache creation
- third block = output tokens
- context glyph = peak context as a fraction of the active model context window, when known

This makes cache behavior visible at a glance without a noisy character soup. A healthy cached long session should show a tall middle block, for example `▂█▁`; a less cached session might look like `█▂▁`.

Fallback states:

```text
AV not installed
AV syncing…
AV no token data
AV unpriced model
AV error
```

## Slash commands

### `/av`

Show a concise summary of current AgentsView state:

- current session id
- session cost
- today's Pi cost
- output tokens
- peak context tokens
- models
- health grade/outcome when available

### `/av-detail`

Show a more detailed widget/panel for current session usage:

- session id
- agent/project
- total output tokens
- peak context tokens
- session cost
- whether token/cost data exists
- models and unpriced models
- server/local source indicator
- AgentsView health details: score, grade, outcome, message counts, signal basis, retries/failures/secrets

### `/av-daily`

Show recent/day-level Pi usage from:

```bash
agentsview usage daily --json --agent pi
```

Include input, output, cache read/write, total cost, and model breakdown if available.

### `/av-breakdown`

Show an experimental estimated attribution for the most recent turn:

- system prompt / skills / loaded tool context
- current user prompt
- conversation history and tool-result context
- exact output tokens from provider usage
- exact total turn cost from provider usage

Important: the provider-reported totals are exact, but the category split is currently estimated from character proportions captured by Pi extension hooks.

### `/av-sync`

Force indexing of the current Pi session:

```bash
agentsview session sync <current-session-file>
```

Then refresh the footer.

### `/av-open`

Open AgentsView:

- Try to open `http://127.0.0.1:8080`.
- If needed, launch `agentsview serve` detached.

### `/av-statusline`

Cycle or set the status display mode:

```text
compact | tokens | daily | visual | off
```

The chosen mode is persisted in the session with `pi.appendEntry()` and restored on session start/reload.

## Research item: token/spend split by prompt category

Desired split:

1. System prompt spend/tokens
   - base system prompt
   - loaded skills
   - MCP/tool descriptions, if present
   - project instructions/context files
2. User/input prompt spend/tokens
   - user messages
   - attached context/images if tokenized by provider
3. Output spend/tokens
   - assistant responses
   - reasoning/thinking, if reported
   - tool-call text emitted by the model

Current finding:

- AgentsView's stable `session usage` API reports `total_output_tokens`, `peak_context_tokens`, `cost_usd`, models, and unpriced models.
- The local DB has message-level fields such as `token_usage`, `context_tokens`, and `output_tokens`, but those are currently associated with assistant turns and represent provider-level aggregate request usage, not an attribution split across system/user/tool/context components.
- Pi session JSONL stores per-assistant-message usage including input, output, cache read/write, and cost, but not an explicit split of input tokens into system vs user vs tool context.

Possible approaches to investigate:

### A. AgentsView upstream/API enhancement

Check whether AgentsView's Pi parser could preserve more Pi-specific structure or whether the schema can expose richer token categories. This would be the cleanest long-term path but depends on whether Pi records enough data.

### B. Pi extension-side instrumentation

Use Pi extension hooks to capture pre-request structure:

- `before_agent_start`: access `event.systemPrompt`, `event.systemPromptOptions`, and user prompt.
- `context`: inspect messages about to be sent to the provider.
- `before_provider_request`: inspect final provider payload.
- `message_end`: read provider usage after completion.

The extension could estimate category token counts by measuring serialized text segments before the request, then allocate reported input cost proportionally. This would be approximate unless we add provider-compatible tokenizers.

### C. Hybrid exact/estimated accounting

Use exact provider-reported totals for:

- total input tokens
- cache read/write tokens
- output tokens
- total cost

Then estimate breakdown percentages for:

- system/tools/skills
- user prompts
- prior assistant/tool context

This could produce a clearly labeled estimate:

```text
Input est: system 42% · user 18% · history/tools 40%
```

### D. Tokenizer-backed accounting

For supported providers/models, add optional tokenizer libraries or model-specific token counting. This improves estimates but increases extension complexity and maintenance.

Open questions:

- Does Pi expose MCP/tool-description text distinctly in `systemPromptOptions.selectedTools` / `toolSnippets` enough to separate tools/MCP from other system text?
- Can cache-read tokens be attributed meaningfully to system vs conversation history?
- Do providers expose reasoning/output-token subcategories that Pi preserves?
- Would AgentsView accept richer Pi parser fields upstream?

Recommendation: implement MVP statusline first, then prototype extension-side instrumentation as an explicitly estimated `/av-breakdown` command.

## Current implementation status

As of the first prototype checkpoint, the repository contains `extensions/agentsview.ts` with:

- AgentsView CLI-backed statusline integration.
- Current Pi session id derivation from the JSONL filename.
- Canonical session id capture from `agentsview session sync <file> --format json`.
- Current-session usage from `agentsview session usage <id> --format json`.
- Session health/outcome details from `agentsview session get <id> --format json`.
- Daily Pi usage from `agentsview usage daily --json --agent pi`.
- Statusline modes: `compact`, `tokens`, `daily`, `visual`, `off`.
- Per-session statusline mode persistence via `pi.appendEntry()`.
- Unicode visual statusline for input/cache/output mix, cache percentage, context pressure, and health grade.
- Slash commands: `/av`, `/av-detail`, `/av-daily`, `/av-breakdown`, `/av-sync`, `/av-open`, `/av-statusline`.
- A first experimental `/av-breakdown` estimate for system/user/history token attribution.

Current example visual statusline:

```text
AV $2.89 · ▂█▁ in/cache/out · cache 85% · ctx ▄ 86k/128k · A
```

Validation performed so far:

```bash
pi --no-extensions -e ./extensions/agentsview.ts --offline --list-models xyznotamodel
```

This confirms the extension loads. Full interactive TUI testing is still pending.

## Next steps

Recommended next iteration after this checkpoint:

1. **Live Pi TUI test**
   - Reload/install the package.
   - Exercise `/av`, `/av-detail`, `/av-daily`, `/av-breakdown`, `/av-statusline visual`, and `/av-sync` in an actual session.
   - Verify statusline width, refresh timing, and widget behavior.

2. **Debounce/throttle refreshes**
   - Avoid expensive repeated CLI sync/query calls when turns end quickly.
   - Add a minimum refresh interval and a manual force path for `/av-sync`.

3. **Improve fallback session resolution**
   - If filename-derived id and `session sync` fail, query `agentsview session list --agent pi` and match by file/session metadata where possible.
   - Handle ambiguous sync outputs explicitly.

4. **Improve `/av-breakdown` accuracy**
   - Inspect final provider payload in `before_provider_request`.
   - Separate current user prompt, prior user prompts, assistant history, tool results, tool descriptions/MCP snippets, and system prompt.
   - Keep exact provider totals; label category attribution as estimated unless tokenizer-backed.

5. **Richer visual widgets**
   - Add a dedicated `/av-dashboard` or improve `/av-detail` with compact Unicode meters for cost, context, cache effectiveness, output growth, health, and signals.

6. **Optional REST optimization**
   - When AgentsView server is running, query REST endpoints directly instead of spawning the CLI for read paths.

## Implementation phases

### Phase 1: MVP CLI-backed extension

- Detect `agentsview` CLI.
- Derive current AgentsView session id from Pi session file.
- On `session_start` and `agent_end`, run sync/query and update footer.
- Register:
  - `/av`
  - `/av-detail`
  - `/av-daily`
  - `/av-breakdown`
  - `/av-sync`
  - `/av-open`
  - `/av-statusline`

### Phase 1.5: Visual statusline experiments

- Add Unicode visual mode for daily input/cache/output mix.
- Persist statusline mode per session.
- Add context pressure gauge when model context window is known.
- Add richer `/av-daily` widget lines with the same visual encoding.
- Experiment with multiple compact visual encodings:
  - token mix sparkline: `▂█▁ in/cache/out`
  - cost meter: `cost ▆ $2.89`
  - context pressure: `ctx ▅ 56k/128k` when model context window is available
  - cache effectiveness: `cache █ 85%`

### Phase 2: Better refresh and session mapping

Started:

- Parse `agentsview session sync <file> --format json` to capture canonical session id.
- Fall back to forced sync when filename-derived id usage lookup fails.
- Query `agentsview session get <id> --format json` for health/outcome/session signals.

Remaining:

- Add throttling/debouncing.
- Handle ambiguous `session sync` outputs more explicitly.
- Fall back to `session list` if filename-derived id and sync both fail.
- Use REST endpoint when AgentsView server is running.

### Phase 3: Estimated prompt-category accounting

Initial prototype is in place via `/av-breakdown`:

- `before_agent_start` captures system prompt and current user prompt sizes.
- `context` captures final message-context size before provider request.
- `message_end` captures exact provider usage/cost from Pi's assistant usage object.
- The split among system/user/history is currently estimated by character share.

Follow-up work:

- Improve attribution by inspecting provider payload in `before_provider_request`.
- Separate tool descriptions/MCP snippets from the rest of the system prompt when possible.
- Distinguish prior user prompts, prior assistant responses, and tool results inside history.
- Consider tokenizer-backed estimates for supported providers.

### Phase 4: Polish

- Persist statusline mode.
- Better widgets/custom UI.
- Configurable refresh interval.
- Optional warning states for unpriced models, no token data, and stale sync.
