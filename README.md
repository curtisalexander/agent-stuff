# agent-stuff

Personal pi coding agent customizations.

Inspired in part by Armin Ronacher's `agent-stuff` repository:
- https://github.com/mitsuhiko/agent-stuff

## Structure

- `extensions/` — TypeScript extensions (custom tools, commands, UI, event handlers)
- `skills/` — Skill definitions (`SKILL.md` folders or top-level `.md` files)
- `prompts/` — Reusable prompt templates (`.md` files, expand with `/name` in pi)
- `themes/` — Custom themes (`.json` files)

## Setup

```bash
pi install ~/code/agent-stuff
```

## Included extensions

### `extensions/powershell.ts`

Adds a `powershell` tool for:

- running PowerShell commands via `pwsh`
- Windows-oriented shell workflows inside pi
- cross-platform PowerShell Core usage on macOS, Linux, and Windows
- automatically preferring PowerShell over `bash` on Windows

## Included skills

### `skills/cdp-browser`

Provides a CDP-powered browser skill for:

- inspired by ideas from Armin Ronacher's `agent-stuff` CDP/web-browser skill
- web search through a real Chromium browser session
- fetching rendered page contents
- handling JavaScript-dependent pages via Chrome DevTools Protocol
