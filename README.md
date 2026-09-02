# agent-stuff

Personal [Pi coding agent](https://pi.dev/) customizations, packaged for direct installation.

This repository targets **Pi 0.84.x**, with 0.84.4 or newer in that release line (`@earendil-works/pi-coding-agent`), and Node.js 22.19 or newer. New Pi minor releases are enabled after the deterministic extension tests pass against them.

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

- running PowerShell commands via `pwsh`, with BOM-less UTF-8 input/output settings and independent streaming decoders for stdout and stderr
- Windows-oriented shell workflows inside pi
- explicit `cmd.exe /c ...` support when a batch file requires cmd syntax
- background processes (dev servers, watchers) that survive across tool calls in the current Pi session runtime
- process-tree cleanup on timeout, cancellation, job removal, and Pi session shutdown
- streaming partial output to the TUI as commands run
- cross-platform PowerShell Core usage on macOS, Linux, and Windows
- automatically preferring the `powershell` tool over `bash` on Windows after verifying that PowerShell 7 can launch
- routing user-entered `!` and `!!` commands through PowerShell on Windows, with unavailable PowerShell tools disabled and Bash left unchanged when PowerShell 7 cannot launch
- per-job environment-variable overrides and bounded cursor-based output consumption for long-running jobs
- PowerShell-native `PS>` foreground rendering, streamed output previews, Ctrl+O expansion, and elapsed time using Pi 0.84's built-in presentation while retaining this extension's execution backend
- compact, width-aware renderers for all background-job tools, including the newest five visual output lines when collapsed
- sticky `pwsh: …` job counts in the status area, natural-completion notifications, and durable non-triggering transcript messages for failed jobs
- `/pwsh-jobs`, an interactive job selector for viewing output and safely stopping or removing jobs

The job-tool API shape is adapted from
[`@marcfargas/pi-powershell`](https://github.com/marcfargas/pi-powershell) (MIT).
Implementation is Node-native rather than PowerShell's `Start-Process`. Pi's PowerShell tool definition supplies the foreground presentation and semantic API types only: process execution, UTF-8 handling, truncation, cleanup, and background-job ownership remain implemented by this extension.

Invoke long-running background programs directly, for example `npm run dev` or `dotnet watch`. Do not wrap them in `Start-Process`, `Start-Job`, a trailing background operator such as `command &`, or another self-detaching/backgrounding construct. PowerShell's `&` call operator is still appropriate for synchronous invocation. On Windows, `taskkill /T /F` can clean up descendants while the root `pwsh` remains alive, but Windows does not provide a durable process-tree handle through Node's standard child-process API after that root exits.

Jobs survive tool calls, not extension-runtime replacement. Pi `/reload`, `/new`, `/resume`, `/fork`, and quit trigger session shutdown, which stops tracked jobs and deletes the extension-owned log directory. On Unix, that directory and its files are created with modes `0700` and `0600`, respectively. Caller-specified log files remain caller-owned and are preserved.

The status area shows tracked job counts such as `pwsh: 2 running · 1 failed · 1 done`; in fullscreen mode Pi 0.84 keeps that area visible while the transcript scrolls independently. A naturally completed job raises a notification. A natural nonzero exit also adds a durable message without triggering an agent turn, so the failure is not lost if it occurs between prompts. Explicit stop, removal, and shutdown do not produce completion notifications. Run `/pwsh-jobs` to inspect jobs, preview output, stop a process tree, or remove a job and extension-owned logs; destructive actions require confirmation.

Use `pwsh-start-job`'s `env` object for per-job environment variables. `pwsh-get-job-output` returns a bounded tail by default; pass `cursor: {}` to read from the beginning, then pass its returned `nextCursor` to consume subsequent chunks without gaps. Pass `full: true` only when raw log paths are needed.

The extension sets `[Console]::InputEncoding`, `[Console]::OutputEncoding`, and `$OutputEncoding` to BOM-less UTF-8 for every command. It decodes stdout and stderr independently before merging them, removes a leading UTF-8 BOM from each stream, and stores normalized UTF-8 job logs. This prevents valid multibyte characters from becoming replacement characters when operating-system chunks or the two streams interleave. The relative ordering of independently buffered stdout and stderr writes is inherently not exact, but each stream's characters remain intact. PowerShell 7 text cmdlets also default to `utf8NoBOM`; use an explicit `-Encoding` when reading or writing a known legacy or non-UTF-8 file.

No launcher can safely infer arbitrary native-program output encodings. Native tools that ignore the UTF-8 console settings and emit an OEM/ANSI code page, UTF-16, or binary data must be configured to emit UTF-8 or redirected to a file and decoded with the known encoding. Once malformed bytes or a replacement character have already been produced by a native tool, file decoder, parent terminal, model/provider, or Pi itself, this extension cannot reconstruct the original character.

PowerShell non-terminating errors do not always produce a failing process exit code. For failure-sensitive automation, opt in explicitly as appropriate:

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
# Inspect $LASTEXITCODE for native tools whose exit codes have special meanings.
```

## Development check

```bash
npm install
npm run check
npm run test:powershell
```

`test:powershell` is a deterministic integration test that loads the extension, invokes real PowerShell without an LLM, and covers executable probing, Windows tool activation and unavailable-PowerShell fallback, user `!` command routing, multiline commands and quoting, UTF-8 input/output settings, BOM-less native pipeline input, deliberately split multibyte stdout interleaved with stderr, per-stream BOM removal, normalized merged job logs, strict errors, merged and separate stdout/stderr, streaming and spilled full output, Pi session and per-job environment variables, foreground and background nonzero exits, timeout/abort descendant cleanup, large-output tail and cursor reads, full-path opt-in, private log permissions, Unicode working directories, background start validation and duplicate prevention, background completion/stop, Unix descendant cleanup, custom-log preservation, shutdown racing an in-flight start, job-directory cleanup across session restart, Pi 0.84 PowerShell/job rendering, sticky job status, completion/failure messages, and `/pwsh-jobs` view/stop/remove flows.

The PowerShell workflow runs this suite on both Ubuntu and a native Windows runner. See `docs/powershell-hardening.md` for the platform-specific verification checklist and the condition that would justify a future Windows Job Object supervisor.

After configuring a model in Pi, run the model-driven integration test with:

```bash
npm run test:powershell:model
```

Pass Pi model options after `--` when needed, for example:

```bash
npm run test:powershell:model -- --model openai-codex/gpt-5.3-codex
```

This runs Pi non-interactively with only the relevant PowerShell extension tools enabled. It verifies five workflows from Pi's JSON event stream: Unicode stdout/stderr, foreground truncation and full-output metadata, timeout recovery, the complete background-job lifecycle, and separate background stdout/stderr logs. Every scenario uses randomized markers and checks the actual tool calls and results rather than trusting the model's final response.

On Linux x64, install the pinned, checksum-verified PowerShell release without root access using:

```bash
npm run setup:powershell
```

To test interactively through Pi 0.84 using the locally installed extension:

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
