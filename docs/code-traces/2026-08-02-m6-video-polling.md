# Code trace: M6 video generation and local polling

- Started: 2026-08-02T15:13:32+08:00
- Repository: `D:\SB\xlngaiforwindows`
- Base revision: `main` at `828fd20`
- Status: in progress

## Objective

Follow `docs/IMPLEMENTATION-PLAN.md` and `docs/QUALITY-GATES.md` for M6: implement a reliable local asynchronous video-generation flow with persisted provider task IDs, bounded polling, restart recovery, cancellation/failure terminal states, video asset registration, task visibility, and verification evidence up to the next human-testing boundary.

## Baseline

- M5 manual acceptance was reported by the user on 2026-08-02 after Hosted Windows CI run `30736751960` succeeded.
- `generation_jobs.provider_task_id` already exists in SQLite, and `IMAGE_TO_VIDEO` adapters already exist in the registry and native provider allowlist.
- Current Provider bridge submits and polls inside a single native request, which is not sufficient for M6 local polling/restart recovery.

## Timeline

### 2026-08-02T15:13:32+08:00 - M6 scope opened
- Evidence: implementation plan lines 214-243 define M6 as Vidu video generation, asynchronous submission, backoff/jitter polling, restart recovery, pause/resume/cancel, result download, asset registration, and task status display.
- Decision: begin with explicit M6 contracts and local state machine before UI changes.
- Next: extend contracts and Worker service around persisted video jobs and Provider task polling boundaries.

### 2026-08-02T15:24:00+08:00 - M6 design gate defined
- Evidence: `docs/QUALITY-GATES.md` requires invariants, a state machine, ownership, a failure matrix, contracts, and a trace table before implementation.
- Action: defined the M6 scope, persistent state transitions, restart behavior, idempotency rules, bounded local polling, session isolation, output validation, and native credential boundary.
- Files: `docs/M6-VIDEO-POLLING.md`
- Decision: an interrupted local `pending` job is failed on restart instead of automatically resubmitted; this avoids duplicate provider tasks and charges when a crash occurs around the external-submit boundary.
- Next: encode the documented Worker IPC and task information contracts.

### 2026-08-02T15:29:04+08:00 - Worker state machine and persistence implemented
- Evidence: the first focused Worker run initially failed 4 of 8 tests because the test process loaded a stale persistence build and two assertions compared dynamic elapsed values; rebuilding `@ai-video/persistence` and correcting invariant-focused assertions produced 8/8 passing tests.
- Action: added Schema v5 `generation_jobs.metadata_json`, video IPC contracts, task ownership/region metadata, transactional provider-task attachment, restart recovery, pause/resume/cancel/timeout states, safe output extraction, bounded streaming download, atomic video asset/result commit, and signed-URL exclusion.
- Files: `packages/contracts/src/index.ts`, `packages/domain/src/index.ts`, `packages/persistence/src/{schema,database,repositories}.ts`, `apps/worker/src/video-generation-service.ts`, `apps/worker/src/handler.ts`
- Commands: `pnpm --filter @ai-video/worker test -- video-generation-service.test.ts` -> exit `0`; 8 tests passed.
- Decision: off-peak task deadline is persisted per job, and Provider region is task-owned so a restart cannot query an international task with domestic credentials or vice versa.

### 2026-08-02T15:41:34+08:00 - Native task bridge and desktop scheduler implemented
- Evidence: desktop focused tests pass with persisted-task recovery calling poll without calling submit; scheduler tests cover deduplication, transient backoff, deadline handling, disposal isolation, and bounded delay.
- Action: split video Provider transport into one-shot submit/poll/cancel commands, added the local scheduler and task center, pause/resume/cancel actions, elapsed/query/cost display, local completion notification, asset refresh, and system-player open action.
- Files: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/provider-client.ts`, `apps/desktop/src/video-polling-scheduler.ts`, `apps/desktop/src/ProductionPanel.tsx`, `apps/desktop/src/App.tsx`
- Commands: `pnpm --filter @ai-video/desktop test` -> exit `0`; 19 tests passed after extending legacy mocks for the new list method.
- Decision: local cancellation is persisted before the best-effort remote cancellation, so a Provider rejection cannot restart local polling.

### 2026-08-02T15:58:42+08:00 - Official Vidu contracts reconciled
- Evidence: Vidu public documentation declares `/ent/v2/reference2video` for 1-7 reference images, `/ent/v2/start-end2video` for exactly two ordered frames, and `/ent/v2/tasks/{id}/cancel` for cancellation; no credentialed request was sent.
- Action: added the Q3 reference-video adapter, corrected Q3 Pro to the start/end endpoint and exact frame count, added the controlled native cancel endpoint, recognized official `credits` cost output, and set off-peak timeout to the documented 48-hour window.
- Files: `packages/generation-adapters/src/index.ts`, `apps/desktop/src-tauri/src/lib.rs`, `apps/worker/src/video-generation-service.ts`, `docs/M6-VIDEO-POLLING.md`
- Commands: adapter tests -> exit `0` (7 tests); Worker tests -> exit `0` (54 tests); desktop tests -> exit `0` (19 tests); `cargo test --offline` -> exit `0` (11 tests).
- Decision: M6 adapter acceptance follows the current official endpoint separation instead of preserving the earlier incorrect single-frame Q3 Pro mapping.
- Next: run adversarial review and full local gates, then package and validate Hosted Windows CI.

### 2026-08-02T16:04:00+08:00 - Initial full local gates reached the review boundary
- Evidence: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, Cargo formatting/check/tests, and the rebuilt sidecar passed; the full TypeScript run contained 15 test files and 103 tests.
- Commands: the first `pnpm lint` run failed on an `expect.stringMatching` unsafe-assignment inference and passed after splitting the assertion; the first `pnpm worker:sidecar` retry failed with `EBUSY` while the completed manual-test desktop process held `better_sqlite3.node`, then passed after stopping only that repository's desktop/Worker processes.
- Decision: treat both failures as reproducible gate evidence rather than omit them; neither changed production behavior.
- Next: complete the required adversarial review before updating the gate totals.

### 2026-08-02T16:19:05+08:00 - Adversarial review fixed the long-download IPC boundary
- Evidence: Worker IPC has a fixed 30-second request timeout, while video download allowed 10 minutes; downloading inside `video.generate.observe` could repeatedly restart the Worker for a valid large video and serialize project close behind the download.
- Action: added persisted `downloading`, moved video transfer to a cancellable Worker background task, made the desktop scheduler refresh local state without re-polling Provider, returned restart leftovers to `polling`, removed strictly named stale temporary files, and guarded callbacks after scheduler disposal.
- Files: `packages/contracts/src/index.ts`, `apps/worker/src/{video-generation-service,handler}.ts`, `apps/desktop/src/{video-polling-scheduler,ProductionPanel}.tsx`, `docs/M6-VIDEO-POLLING.md`, `docs/QUALITY-GATES.md`
- Commands: focused Worker video tests -> exit `0` (9 tests); focused scheduler tests -> exit `0` (8 tests); `pnpm typecheck` -> exit `0`.
- Decision: Provider success and local media transfer are separate persisted states; a restarted `downloading` task is queried again for a fresh signed URL instead of persisting the old URL.
- Next: rerun every local gate, audit the final diff and sensitive content, then push for Hosted Windows validation.

### 2026-08-02T16:26:38+08:00 - Final local gates and clean installer lifecycle passed
- Evidence: all local static, test, build, native, sidecar, and installed-process lifecycle checks passed after the background-download correction.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm worker:sidecar`, `cargo fmt --check`, `cargo check --offline`, `cargo test --offline`, `pnpm tauri:build`, and `scripts/validate-nsis-install.ps1` -> exit `0`; 15 TypeScript test files/107 tests and 11 Rust tests passed.
- Evidence: clean NSIS validation confirmed the installed `ai-video-worker.exe` started, survived startup checks, exited after graceful desktop close, and was removed on uninstall.
- Artifact: x64 NSIS installer size `20,255,794` bytes; SHA-256 `C8A5E8030AE433B59303F1A6B49D7A66CB8870B64866ED0F60F83518D9E2DE2C`.
- Commands: the first `pnpm tauri:build` attempt did not enter compilation because Cargo was absent from the non-interactive PowerShell `PATH`; rerunning with the already-installed Cargo directory added only to that command environment passed.
- Residual: no real credential was read and no real Vidu task was submitted; M6 remains `in progress` until Hosted Windows CI and the documented human test are complete.
- Next: perform final Git/sensitive-content audit, commit and push, then wait for Hosted Windows CI.

### 2026-08-02T16:29:11+08:00 - Pre-commit audit passed
- Evidence: `git diff --check` passed; all 28 changed or new paths belong to M6 implementation, tests, quality records, or the user-confirmed M5 sign-off.
- Evidence: changed/untracked-file scanning found no OpenAI-style key, AWS access key, bearer literal, or private-key block; one generic API-key rule matched the explicit `must-not-persist` negative-test placeholder and was confirmed non-secret. Git tracks no `.env`, SQLite database, certificate, or private-key artifact.
- Decision: the worktree is eligible for commit; generated installer, build directories, credentials, and project runtime data remain untracked.
- Next: push the M6 implementation commit and require Hosted Windows CI success before human-testing handoff.

### 2026-08-02T16:46:17+08:00 - First Hosted Windows run failed without a reproducible assertion
- Evidence: GitHub Actions run `30739886232` for commit `a270096` passed setup, dependency installation, native-module alignment, formatting, build, lint, and typecheck, then failed the TypeScript test step; later packaging steps were correctly skipped. The public check annotation exposed only exit code `1`, while detailed logs required an authenticated repository session that was not available and no credential was accessed.
- Experiment: used the bundled Node `24.14.0`, ran the same native-module alignment command, and reran `pnpm test`; all 15 files/107 tests passed. Then ran the complete Worker and Desktop suites 15 consecutive times under Node 24; every iteration passed.
- Decision: retain the Hosted failure as an unresolved transient result and trigger a second full Hosted run with this trace-only commit. Do not hand off M6 unless the rerun completes through NSIS installation successfully.
- Next: monitor the rerun; repeated failure blocks M6 and requires added CI-side diagnostics before another attempt.

### 2026-08-02T17:00:11+08:00 - Hosted Windows rerun passed the complete release path
- Evidence: GitHub Actions run `30740465271` for commit `1e6e94b` completed with `success`; formatting, TypeScript build/lint/typecheck/tests, standalone Worker, Rust/Tauri check, NSIS bundle, and clean NSIS install lifecycle all passed.
- Evidence: the prior TypeScript-step failure did not recur under the same Hosted workflow and was not reproduced by the local Node 24 full run or 15 consecutive Worker/Desktop stress iterations. It remains recorded above instead of being overwritten.
- Decision: M6 automated code, native, packaging, installed-process, and Hosted gates are `PASS`. No real credential was read and no real Vidu request was sent automatically.
- Status: M6 remains `in progress` at the required human-testing boundary; do not enter M7 until the user validates the real desktop video flow and reports the result.
- Next: manually submit one Vidu reference-video or start/end-frame task, exercise pause/resume and app restart recovery while it is active, then confirm the completed video opens locally and appears in the selected material category.
