# agent-stuff

Personal pi coding agent customizations.

Inspired in part by Armin Ronacher's `agent-stuff` repository:
- https://github.com/mitsuhiko/agent-stuff

## Structure

- `extensions/` — TypeScript extensions (custom tools, commands, UI, event handlers)
- `skills/` — Skill definitions (`SKILL.md` folders or top-level `.md` files)
- `prompts/` — Reusable prompt templates (`.md` files, expand with `/name` in pi)
- `themes/` — Custom themes (`.json` files)

## Quick start

If you already have this repo locally, install it into pi with:

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

### Extra dependencies and considerations

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

The CDP browser skill has a local Node dependency.
Install it once after cloning:

```bash
cd skills/cdp-browser
npm install
cd ../..
```

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

### `extensions/powershell.ts`

Adds a `powershell` tool plus a set of background-job tools (`pwsh-start-job`,
`pwsh-get-job`, `pwsh-stop-job`, `pwsh-remove-job`, `pwsh-get-job-output`) for:

- running PowerShell commands via `pwsh`, with forced UTF-8 output
- Windows-oriented shell workflows inside pi
- automatic `.cmd`/`.bat` retry via `cmd.exe /c` when pwsh fails on Windows
- background processes (dev servers, watchers) that survive across tool calls
- streaming partial output to the TUI as commands run
- cross-platform PowerShell Core usage on macOS, Linux, and Windows
- automatically preferring PowerShell over `bash` on Windows

The job-tool API shape is adapted from
[`@marcfargas/pi-powershell`](https://github.com/marcfargas/pi-powershell) (MIT).
Implementation is Node-native rather than PowerShell's `Start-Process`.

## Included skills

### `skills/cdp-browser`

Provides a CDP-powered browser skill for:

- inspired by ideas from Armin Ronacher's `agent-stuff` CDP/web-browser skill
- web search through a real Chromium browser session
- fetching rendered page contents
- handling JavaScript-dependent pages via Chrome DevTools Protocol
