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

## Verification and distribution

- [x] Add deterministic coverage for executable probing, shutdown races, quoting, paths, start validation, and exit codes.
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

Deterministic checks for activation, fallback, and foreground descendant cleanup are included in `test:powershell`; the remaining boxes should be checked after the updated suite completes on the native Windows runner.

If dependable ownership of self-detached Windows descendants becomes necessary, replace the best-effort contract with a Windows Job Object supervisor using `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
