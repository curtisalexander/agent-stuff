# PowerShell extension hardening

This checklist tracks the deep-review follow-up for `extensions/powershell.ts`.

## Implemented locally

- [x] Probe PowerShell 7 before replacing `bash` on Windows.
- [x] Preserve `bash` and show installation guidance when `pwsh` is unavailable.
- [x] Serialize extension shutdown with in-flight background-job starts.
- [x] Reject new background jobs after shutdown begins.
- [x] Define Windows process-tree cleanup as best effort while the root `pwsh` remains alive.
- [x] Tell agents to invoke long-running programs directly rather than through self-detaching PowerShell constructs.
- [x] Document PowerShell's non-terminating error and native exit-code semantics.
- [x] Restrict extension-owned job directories and logs to the current Unix user and delete the directory on shutdown.
- [x] Add per-job environment overrides and incremental cursor-based output reads.
- [x] Set PowerShell console input, console output, and native pipeline input to BOM-less UTF-8.
- [x] Decode stdout and stderr independently so interleaved chunks cannot corrupt split UTF-8 characters.
- [x] Normalize foreground spill files and background logs to UTF-8 while removing one leading BOM per stream.
- [x] Avoid decoding incomplete trailing UTF-8 characters while a live job log is being read.
- [x] Spawn Windows `taskkill.exe` from the trusted absolute System32 path rather than searching `PATH`.

## Pi 0.84 user experience

- [x] Keep the extension's cross-platform execution, UTF-8, truncation, process-tree, and job-lifecycle implementation.
- [x] Use Pi's PowerShell tool definition for semantic types and `PS>` foreground presentation without adopting its Windows-only executor.
- [x] Add compact, width-aware call/result renderers for every background-job tool with Ctrl+O expansion.
- [x] Show the newest five visual output lines when job output is collapsed and keep bounded output available when expanded.
- [x] Separate tool-operation duration from the persistent background job's age.
- [x] Add sticky running/failed/done job counts that remain visible in Pi's fullscreen layout.
- [x] Notify on natural completion, persist natural failures without triggering an agent turn, and suppress those messages for explicit cleanup.
- [x] Add `/pwsh-jobs` for interactive output viewing and confirmed stop/remove actions.
- [x] Use the softer `You can inspect PI_*...` prompt guidance adopted by Pi's native PowerShell tool.

## Verification and distribution

- [x] Add deterministic coverage for executable probing, shutdown races, quoting, paths, start validation, and exit codes.
- [x] Add deterministic coverage for per-stream BOMs and split multibyte characters across foreground updates, spill files, and merged background logs.
- [x] Add deterministic coverage for Pi 0.84 rendering, sticky job status, completion/failure messages, and the interactive job manager.
- [x] Run type checking and deterministic PowerShell integration tests on Linux with PowerShell 7.6.4.
- [x] Configure the integration workflow for both Ubuntu and native Windows runners.
- [x] Bound the supported Pi and TypeBox versions to tested compatibility ranges.
- [x] Correct and expand the user documentation.

## Requires a native Windows environment

- [x] Add a Windows CI workflow and a cross-platform direct-child process-tree test.
- [ ] Verify automatic tool activation when PowerShell 7 is present.
- [ ] Verify `bash` remains active when PowerShell 7 is absent.
- [ ] Verify foreground timeout and cancellation kill Windows descendants.
- [x] Verify `taskkill /T /F` stops directly launched long-running workloads.
- [ ] Confirm and document the unsupported self-detaching `Start-Process` case.
- [ ] Run the split-stream/BOM regression cases on the native Windows CI runner.

Deterministic checks for activation, fallback, and foreground descendant cleanup are included in `test:powershell`; the remaining boxes should be checked after the updated suite completes on the native Windows runner.

If dependable ownership of self-detached Windows descendants becomes necessary, replace the best-effort contract with a Windows Job Object supervisor using `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
