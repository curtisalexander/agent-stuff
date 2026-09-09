# PowerShell extension hardening

This checklist tracks the deep-review follow-up for `extensions/powershell.ts`.

## Required supervision and bounded logs

The follow-up explicitly approved native supervision as a prerequisite, with no process-group-only fallback. Background jobs now use a separate guardian connected to Pi by a private socket. Configuration and environment travel over that socket, not command-line arguments or persistent PID/config files.

- **Linux:** `systemd-run --user --pipe --wait --collect --service-type=exec` starts a transient service with `KillMode=control-group`, `TimeoutStopSec=3s`, and `SendSIGKILL=yes`. The Node guardian is the service's main process. Root workload exit, a stop command, or lifetime-socket EOF makes it exit; systemd then terminates all remaining cgroup members, including `setsid`/detached children. Guardian SIGKILL is covered by the same OS cleanup. A missing executable, user manager, D-Bus connection, or permission fails startup before acknowledgement. See [systemd-run](https://www.freedesktop.org/software/systemd/man/systemd-run.html).
- **Windows:** a PowerShell-hosted C# guardian creates an unnamed, non-inherited `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` handle and assigns itself to the Job Object **before** spawning the workload. Neither breakaway flag is enabled. Owner disconnection, guardian death, and normal root exit close the last handle and terminate contained children. Every native setup call is checked; assignment failure does not fall back to `taskkill`. See [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) and [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).
- **macOS/other platforms:** background starts fail closed; the foreground tool remains usable. No launchd process-group fallback is presented as equivalent containment.
- **Logs:** one shared 10 MiB byte budget per job covers merged/separate/caller-owned captured logs. `maxLogBytes` can explicitly select 1 byte through 1 GiB. Exceeding the budget preserves a complete UTF-8 prefix and stops the entire job. Write failures also stop it. Output capture failure is retained separately from the actual process exit code, counted/rendered as failure, and reported once in the transcript. No log rotation invalidates cursors. Discarded streams consume no budget.
- **Cancellation:** startup abort prevents sending the payload when the guardian is not yet ready and terminates any in-flight launch. Once startup is acknowledged, its old abort signal no longer owns the background job. Concurrent stop/removes share cleanup, including automatic stops on output failure.

### Verification record and release gate

`npm run check`, `npm run test:powershell:supervisor`, and `npm run test:powershell` pass on Linux with PowerShell 7.6.4, Node 22.19, and Pi 0.85.1. In this orb tests use `XDG_RUNTIME_DIR=/run/user/1000` after starting `user@1000.service`. Native crash tests hard-kill the owner and guardian, observe exact workload/detached-descendant PIDs disappear, and verify an unrelated process survives. They also cover failed startup and early versus late cancellation. Integration tests cover merged/separate quotas, exact and split-Unicode boundaries, discarded streams, caller-owned logs, automatic descendant cleanup, and `/dev/full` failures.

Windows PowerShell parsing, embedded C# compilation, and configuration deserialization were checked under Linux PowerShell. **Those checks do not verify Windows Job Objects.** The Ubuntu/Windows workflow now runs the supervisor suite as a required step alongside integration tests. Native Windows must pass before release; this thread has not pushed or triggered that run. The model-driven test was attempted but could not run because the orb has no configured model API key/OAuth login.

### Remaining boundaries, not silent fallback guarantees

Containment is not a security sandbox. Work delegated to an external broker (WMI, scheduled tasks, systemd/launchd, Docker, etc.), or a workload with privileges to change its containment, is outside this contract. The foreground tool retains its prior best-effort process-group/taskkill behavior and Pi-managed spill files. Arbitrary kernel/filesystem hangs cannot be made bounded by a JavaScript timeout.

A machine/owner crash can leave bounded diagnostic log files and small control directories. There is no PID-based recovery or unsafe automatic deletion of old sessions. No surviving process is adopted after restart. Per-job quotas do not cap command-created files, aggregate disk use across arbitrary numbers of jobs, or foreground spill files. No global signal/uncaught-exception hooks interfere with Pi or other extensions.

## Pi 0.85.1 lifecycle review (2026-09-09)

The npm registry's `latest` tag was **0.85.1**, matching the September 5 release in the [coding-agent changelog](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/CHANGELOG.md). Development dependencies and peer compatibility now target 0.85.1 / the 0.85 release line. This is a tested compatibility target, not a claim that earlier versions are necessarily broken.

### Findings addressed

| Finding | Failure sequence | Resolution |
| --- | --- | --- |
| Owned-log collision | `build` with separate stdout and `build-stdout` with merged output both used `build-stdout.log`; the second start truncated the first log, and either removal deleted the other's log. Case-variant names also collided on Windows. | UUID-based owned filenames, independent of job names and name reuse. Caller-specified paths retain their existing behavior. |
| Overlapping cleanup | Tool calls, shutdown, and the interactive manager could independently kill and unlink the same job. A delayed confirmation could delete a replacement's map entry by name. | One shared stop/removal promise per job, identity-checked map deletion, and retry after failed cleanup. Successfully removed records remain safe to reference from stale UI callbacks. |
| Failed Windows cancellation | A missing or failed `taskkill` returned false, but foreground execution kept waiting for the process and ignored that failure. A hung helper had no deadline. | Five-second helper deadline, root kill fallback, and foreground cleanup failure raced against process completion. Incomplete tree cleanup is an error, not a successful cancellation. |
| False-positive readiness tests | The output helper searched a status response that also echoed the command, so `Write-Output ready` could satisfy the check before execution. | Read captured output sections only. Cursor tests now reconstruct and compare all 20,000 Unicode lines, rather than merely looking for first/last markers. |

### Current upstream contracts and choices

- [`createPowerShellToolDefinition`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/tools/powershell.ts) is the supported integration point. Keep it: its shared [shell wrapper](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/tools/bash.ts) handles `ctx.cwd`, current PI environment, streaming accumulation, spill files, truncation, renderers, and error formatting. Removed the redundant per-execution definition reconstruction; a changed-runtime-CWD regression verifies the upstream behavior.
- `PowerShellOperations` aliases `BashOperations`: `exec(command, cwd, { onData, signal, timeout, env })` returns `{ exitCode }`. Timeout units are seconds. Custom operations own spawning, UTF-8 normalization, and termination. Returning `operations` from `user_bash` preserves Pi's normal `!`/`!!` handling.
- Keep the custom executor. Pi's default PowerShell resolver is still Windows-only and can fall back to Windows PowerShell; this extension intentionally requires PowerShell 7 and works on Linux/macOS too. Internal detached-PID tracking is not exported from the [public entry point](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/index.ts); do not import it through private paths.
- Tools can execute concurrently. Coalesce destructive work on each job, rather than serializing unrelated jobs or the entire extension.
- The [session event types](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/extensions/types.ts) distinguish shutdown reasons `quit`, `reload`, `new`, `resume`, and `fork`. [Runtime replacement](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session-runtime.ts) settles active work and awaits shutdown before replacement. The existing start barrier and shutdown handler fit this contract. There is no shutdown-event deadline or abort signal to consume.
- Stop/remove deliberately complete cleanup once requested, even if their tool signal is later aborted. Conversely, aborting a completed start call must not cancel the background job it successfully created.

### Verification and remaining limits

The Linux suite uses real PowerShell 7.6.4 and Pi 0.85.1. It covers the findings above, concurrent stop/removes followed by same-name restart, a stale confirmation that creates a replacement before resolving, abrupt PowerShell self-termination with exactly one durable failure message, and a native child that ignores SIGTERM and requires SIGKILL. Existing tests cover shutdown during startup, partial log-open/write failures, descendant termination, Unicode boundaries, and cleanup across session restart. Type checking includes all repository extensions after the shared dependency update.

Native Windows execution is still required for the new missing-`taskkill` and case-insensitive-path regressions, alongside the existing Windows activation and process-tree tests. The existing Ubuntu/Windows CI matrix includes them; this review did not trigger CI or claim a native Windows run. The model-driven suite is separate from these deterministic checks.

The initial review deferred native supervision and log policy. The approved follow-up above supersedes that decision for background jobs; global exception handlers and persistent PID recovery remain deliberately excluded.

## Implemented locally

- [x] Probe PowerShell 7 before replacing `bash` on Windows.
- [x] Preserve `bash` and show installation guidance when `pwsh` is unavailable.
- [x] Serialize extension shutdown with in-flight background-job starts.
- [x] Reject new background jobs after shutdown begins.
- [x] Define foreground Windows cleanup as best effort; require Job Objects for background jobs.
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
- [ ] Verify Job Object cleanup after owner/guardian death and for detached native descendants.
- [ ] Run the split-stream/BOM regression cases on the native Windows CI runner.

Deterministic checks for activation, fallback, and foreground descendant cleanup are included in `test:powershell`; the remaining boxes should be checked after the updated suite completes on the native Windows runner.

Windows Job Object supervision is implemented; the native test gate above must pass before release.
