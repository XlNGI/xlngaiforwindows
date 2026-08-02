# Code trace: M7 hardening follow-up

- Started: 2026-08-03T00:18:39+08:00
- Repository: D:\SB\xlngaiforwindows
- Base revision: main at afb340bc9f38e44d10e2eeea5070789bd165bbb0
- Status: complete

## Objective

Reopen M7 after adversarial failure-path review, fix the reported signed-URL persistence, project-session rollback, asset deletion, media commit, disk-capacity, stale LLM polling, and development HTTP-origin weaknesses, and rerun all local and Hosted Windows gates before restoring any automatic-pass claim.

## Baseline

- The worktree was clean and `main` matched `origin/main`.
- The review reported three P1 and four P2 issues despite the previous green automated suite.
- Targeted failure injection reproduced closed-database sessions, irreversible asset-file deletion, and orphaned image output; current tests did not cover those invariants.
- M7 remains `HOLD`, and this follow-up treats the automatic quality status as failed until the new regression tests and full gates pass.

## Timeline

### 2026-08-03T00:18:39+08:00 - Adversarial findings accepted

- Evidence: The supplied reproductions identify persistence, rollback, deletion-order, disk-reserve, stale-response, and local HTTP trust-boundary gaps at concrete code locations.
- Action: Reopened M7 and fixed the implementation order as P1 signed URL/session/delete, then P2 image rollback/video capacity/UI request ownership/development HTTP authentication.
- Decision: Green happy-path tests do not override injected database/filesystem failures; each finding requires a regression test at the failing boundary.
- Next: Inspect current ownership and persistence paths, then implement the three P1 fixes first.

### 2026-08-03T00:34:03+08:00 - P1 failure paths frozen as regression tests

- Evidence: New tests reproduced all three P1 findings: signed query parameters remained in both persisted URL fields, an injected asset INSERT left the job exception/running path, an injected asset DELETE removed the file while retaining the row, and recent-project metadata failure left a closed database behind `current()`.
- Action: Added persistence, backup-byte, SQLite trigger, file-preservation, and unusable-recent-path assertions before changing production code.
- Files: `apps/worker/src/image-generation-service.test.ts`, `apps/worker/src/project-service.test.ts`
- Commands: `pnpm --filter @ai-video/worker test -- project-service.test.ts image-generation-service.test.ts` -> exit `1`; 31 passed and the 4 intended regression cases failed.
- Decision: Treat recent-project history as non-critical metadata; project/database state and local asset bytes remain the authoritative data that must survive auxiliary or SQLite failures.
- Next: Implement URL sanitization, best-effort recent history, atomic image registration rollback, and recoverable asset deletion.

### 2026-08-03T00:48:16+08:00 - P1/P2 hardening implemented and targeted tests green

- Evidence: The prior 4 failing P1 regressions now pass; chunked video download, stale LLM response, and secured development HTTP endpoint tests also pass. The HTTP integration test exercised the real local server and received 403/415 for invalid trust inputs and 200 only for the allowed origin, JSON, and current token.
- Action: Sanitized new image URLs, added SQLite v6 cleanup for existing signed URLs, made recent-project history best-effort, added image/file rollback and tombstone deletion, checked disk reserve per streamed video chunk, invalidated stale LLM poll owners, and enabled origin/content-type/random-token checks for `--dev-http`.
- Files: `packages/persistence/src/schema.ts`, `packages/persistence/src/database.ts`, `apps/worker/src/project-service.ts`, `apps/worker/src/image-generation-service.ts`, `apps/worker/src/video-generation-service.ts`, `apps/worker/src/dev-http-security.ts`, `apps/worker/src/index.ts`, `apps/desktop/src/App.tsx`, `apps/desktop/vite.config.ts`
- Commands: targeted Persistence, Worker, Desktop typechecks/tests -> exit `0` after rebuilding the Persistence package; the first Worker rerun saw stale built schema v5 and was corrected by rebuilding `@ai-video/persistence` before retesting.
- Decision: Apply the URL scrub as a forward SQLite migration so existing projects stop propagating old signed query parameters into future backups and exports.
- Next: Format, update authoritative M7 gate documents with the reopened findings, then execute the complete local release matrix.

### 2026-08-03T00:57:31+08:00 - Full local M7 release matrix passed

- Evidence: Formatting, lint, typecheck, build, 22 test files/146 tests, packaged M7 Sidecar, Rust format/check and 12 tests, Tauri/NSIS build, clean install, and same-installer overwrite/external-project preservation all passed. The unsigned candidate was rejected by the signature validator with the expected `NotSigned` status.
- Action: Closed the running development desktop/Worker process that held `better_sqlite3.node`, made the live HTTP test wait for its child process exit, rebuilt the Sidecar, and reran the affected gate successfully. Used the installed Cargo executable by absolute path because the tool process PATH omitted `.cargo/bin`.
- Files: `apps/worker/src/dev-http-integration.test.ts`, `docs/QUALITY-GATES.md`, `docs/M7-STABILITY-RELEASE.md`
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm worker:sidecar`, M7 Sidecar validation, Cargo fmt/check/test, `pnpm tauri:build`, clean NSIS and overwrite validation -> exit `0` after resolving the file lock; signature validation -> expected `NotSigned` rejection.
- Evidence artifact: x64 NSIS size `20,275,869` bytes; SHA-256 `1DC290F9FCDD9773B275026D24C662EC5C7E6CE929005FF9506844B29474A7C8`.
- Decision: Local code-level P1/P2 are cleared, but M7 stays `HOLD` until the current commit passes Hosted Windows and the documented human release gates are completed.
- Next: Re-run the source gates after documentation edits, review the final diff, commit and push `main`, then monitor the new Hosted Windows run.

### 2026-08-03T01:11:26+08:00 - Hosted Windows hardening gate passed

- Evidence: GitHub Actions run `30757944779` completed `success` for commit `a8ddaa261c117b32d6f60fdafad2df45da97260d`; its Windows `validate` job completed all 22 steps, including 146 tests, Sidecar validation, Tauri/NSIS build, clean install, and overwrite/external-project preservation.
- Action: Pushed the verified hardening commit after bypassing the stale per-user Git proxy only for GitHub commands; updated the M7 quality and release documents with the current run rather than relying on an earlier candidate's CI.
- Commands: `git -c http.proxy= -c https.proxy= push origin main` -> exit `0`; GitHub Actions API polling -> completed `success`.
- Residual risks: Formal Authenticode signing, a real previous-version upgrade, clean Windows VM, current release-candidate Provider requests, disconnect/reconnect, system sleep, low-disk human exercise, and final human release signoff remain outside automated authority.
- Rollback: Revert commit `a8ddaa2`; SQLite v6 is forward-only, so projects already opened by this candidate retain sanitized URL fields even if application code is rolled back.
- Decision: The hardening follow-up is complete and automatic M7 gates are green. M7 itself remains `HOLD` at the documented human release boundary.
