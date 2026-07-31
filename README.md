# agent-stuff

Personal [Pi coding agent](https://pi.dev/) customizations, packaged for direct installation.

This repository targets **Pi 0.83.0 or newer** (`@earendil-works/pi-coding-agent`) and Node.js 22.19 or newer.

Inspired in part by Armin Ronacher's `agent-stuff` repository:
- https://github.com/mitsuhiko/agent-stuff

## Structure

- `extensions/` — TypeScript extensions (custom tools, commands, UI, event handlers)
- `skills/` — Skill definitions (`SKILL.md` folders or top-level `.md` files)
- `docs/` — Design notes and the longer Pi customization guide
- `package.json` — Pi resource manifest and shared runtime dependencies

## Quick start

Install directly from GitHub:

```bash
pi install git:github.com/curtisalexander/agent-stuff
```

Pi clones the repository and installs its runtime dependencies automatically. If you already have this repo locally, install it with:

```bash
pi install ~/code/agent-stuff
```

You can also install from the current directory:

```bash
pi install .
```

Then reload pi:

```bash
/reload
```

## Detailed setup

Clone and install:

```bash
git clone https://github.com/curtisalexander/agent-stuff.git
cd agent-stuff
pi install .
```

### Runtime requirements and considerations

#### PowerShell extension

The PowerShell extension requires PowerShell Core to be installed and available as `pwsh`.

Check it with:

```bash
pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
```

You can override the binary path with:

```bash
export POWERSHELL_BIN=/path/to/pwsh
```

#### CDP browser skill

The CDP browser skill's `ws` dependency is declared at the repository root and is installed automatically by `pi install`. For a development checkout, run `npm install` once at the repository root.

It also requires a Chromium-based browser with remote debugging enabled.
The easiest way is:

```bash
node skills/cdp-browser/scripts/start.js
```

You can then verify CDP is available with:

```bash
curl http://127.0.0.1:9222/json/version
```

After installing dependencies, reload pi if needed:

```bash
/reload
```

## Included extensions

### `extensions/agentsview.ts`

Adds an experimental AgentsView statusline and slash commands for Pi token/spend analytics:

- footer status like `AV $0.42 sess · $3.18 today · 91k ctx`
- `/av`, `/av-detail`, `/av-daily`, `/av-breakdown`, `/av-sync`, `/av-open`, `/av-statusline`
- visual mode like `AV $2.89 · ▂█▁ in/cache/out · cache 85% · ctx ▄ 56k/128k · A`
- current-session health/outcome details from AgentsView in `/av-detail`
- uses the local `agentsview` CLI and Pi session files indexed by AgentsView

See `docs/agentsview-extension-plan.md` for the design notes and follow-up research plan for system/user/output token attribution.

### `extensions/powershell.ts`

Adds a `powershell` tool plus a set of background-job tools (`pwsh-start-job`,
`pwsh-get-job`, `pwsh-stop-job`, `pwsh-remove-job`, `pwsh-get-job-output`) for:

- running PowerShell commands via `pwsh`, with forced UTF-8 output
- Windows-oriented shell workflows inside pi
- explicit `cmd.exe /c ...` support when a batch file requires cmd syntax
- background processes (dev servers, watchers) that survive across tool calls
- process-tree cleanup on timeout, cancellation, job removal, and Pi shutdown
- streaming partial output to the TUI as commands run
- cross-platform PowerShell Core usage on macOS, Linux, and Windows
- automatically preferring PowerShell over `bash` on Windows

The job-tool API shape is adapted from
[`@marcfargas/pi-powershell`](https://github.com/marcfargas/pi-powershell) (MIT).
Implementation is Node-native rather than PowerShell's `Start-Process`.

## Development check

```bash
npm install
npm run check
npm run test:powershell
```

`test:powershell` is a deterministic integration test that loads the extension, invokes real PowerShell without an LLM, and covers success, merged stdout/stderr, streaming, Pi session environment variables, nonzero exits, timeout, abort, large-output spill/truncation, background completion/stop, and custom-log preservation.

On Linux x64, install the pinned, checksum-verified PowerShell release without root access using:

```bash
npm run setup:powershell
```

To test interactively through Pi 0.83 using the locally installed extension:

```bash
npm run pi -- -e ./extensions/powershell.ts
```

Inside Pi, use `/login`, select **ChatGPT Plus/Pro (Codex)**, and complete the browser authorization if this machine does not already have Pi credentials. This uses the ChatGPT subscription flow, not an OpenAI API key. Credentials stay in Pi's local configuration; do not paste tokens into prompts or issue trackers.

## Included skills

### `skills/cdp-browser`

Provides a CDP-powered browser skill for:

- inspired by ideas from Armin Ronacher's `agent-stuff` CDP/web-browser skill
- web search through a real Chromium browser session
- fetching rendered page contents
- handling JavaScript-dependent pages via Chrome DevTools Protocol
