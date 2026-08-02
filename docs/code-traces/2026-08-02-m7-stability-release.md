# Code trace: M7 stability and release

- Started: 2026-08-02T22:16:45+08:00
- Repository: D:\SB\xlngaiforwindows
- Base revision: main at 5e105c8fd80af1e8517724970e568e46ed6db16f
- Status: stopped

## Objective

Implement M7 in the documented order: specify stability and release invariants first, then add redacted diagnostics, cache maintenance, sample onboarding, failure-path coverage, Windows upgrade checks, and release evidence up to the real-credential and human-release boundary.

## Baseline

- The worktree was clean and `main` matched `origin/main`.
- Project backup, restore, export, SQLite integrity checks, NSIS build, clean install, Worker startup, graceful shutdown, and uninstall checks already existed.
- No diagnostic export, shared diagnostic redaction, cache maintenance IPC, sample project flow, or installer upgrade lifecycle check existed.
- The running development desktop process was available at the start of M7.

## Timeline

### 2026-08-02T22:16:45+08:00 - M7 scope and quality contract frozen

- Evidence: `docs/IMPLEMENTATION-PLAN.md` defines M7 after M6 and requires diagnostics, cache cleanup, resilience tests, upgrade/install/signing work, and first-run/sample experience.
- Action: Added the M7 use cases, invariants, state/ownership definitions, fault matrix, IPC contracts, diagnostic package format, traceability table, and release boundary.
- Files: `docs/M7-STABILITY-RELEASE.md`
- Decision: Real provider spending and production code signing remain explicit human gates; deterministic local and Hosted Windows checks may proceed automatically.
- Next: Add contract tests and Worker services for diagnostics, cache maintenance, and sample projects.

### 2026-08-02T22:42:40+08:00 - Diagnostics, cache maintenance, and sample onboarding implemented

- Evidence: Worker tests passed with 70 tests across 10 files; desktop tests passed with 30 tests across 4 files. Workspace typecheck, lint, and format checks passed.
- Action: Added bounded diagnostic redaction/export, in-memory error events, cache inspection/clearing without following links, atomic sample project seeding, disk-capacity preflight, media size checks, IPC routes, first-use sample action, and a project maintenance dialog.
- Files: `apps/worker/src/maintenance-service.ts`, `apps/worker/src/sample-project-service.ts`, `apps/worker/src/storage-capacity.ts`, `apps/worker/src/handler.ts`, `apps/desktop/src/App.tsx`, `packages/contracts/src/index.ts`
- Commands: `pnpm --filter @ai-video/worker test -- --runInBand` -> exit `1`; Vitest rejected the unsupported CLI option before running tests. `pnpm --filter @ai-video/worker test` -> exit `0`; 70 tests passed after the implementation checkpoint. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and desktop tests -> exit `0`.
- Decision: Diagnostic paths can only be reopened when issued by the current Worker session. Cache clearing requires a writable project; inspection and diagnostics remain available in read-only mode.
- Next: Verify the packaged Sidecar, then add Windows reinstall/upgrade and signing checks.

### 2026-08-02T22:42:40+08:00 - Packaged Worker M7 lifecycle verified

- Evidence: The first Sidecar build attempt failed with `EBUSY` because the running development application held the native SQLite module. After gracefully closing that development instance, the build and M7 Sidecar validation passed.
- Action: Added a standalone validation that sends malformed JSON, confirms subsequent health, creates an offline sample, inspects and clears cache, exports and scans diagnostics, and checks SQLite integrity.
- Files: `apps/worker/scripts/validate-m7-sidecar.mjs`, `.github/workflows/ci.yml`
- Commands: `pnpm worker:sidecar` -> first exit `1` (`better_sqlite3.node` locked), retry exit `0`; `pnpm --filter @ai-video/worker validate:m7-sidecar` -> exit `0`.
- Decision: Packaged-process evidence is required in addition to direct unit tests because parser recovery and bundled native SQLite behavior cross the Node module boundary.
- Next: Implement the installer overwrite/upgrade lifecycle and release checklist.

### 2026-08-02T23:02:00+08:00 - Windows release lifecycle baseline verified

- Evidence: The NSIS clean-install lifecycle passed. The same-installer overwrite baseline preserved the external project ID, document digest, SQLite integrity, and project directory after uninstall.
- Action: Added the overwrite/upgrade validator, signature validator, release checklist, and user troubleshooting guide; integrated the M7 Sidecar and installer lifecycle checks into Hosted Windows CI.
- Files: `scripts/validate-nsis-upgrade.ps1`, `scripts/validate-windows-signature.ps1`, `docs/RELEASE-CHECKLIST.md`, `docs/USER-TROUBLESHOOTING.md`, `.github/workflows/ci.yml`
- Commands: `pnpm tauri:build`, `scripts/validate-nsis-install.ps1`, and `scripts/validate-nsis-upgrade.ps1` -> exit `0`.
- Decision: Same-installer overwrite is a deterministic installer baseline, not evidence of a real previous-version migration.

### 2026-08-02T23:05:00+08:00 - Desktop maintenance layout checked

- Evidence: At 1280x720 the dialog stayed within the viewport with no control overflow. At 390x844 it measured 374x508 at x=8..382 and y=168..676; no interactive control overflow, viewport escape, or pairwise overlap was detected.
- Action: Opened an existing project, inspected the full maintenance mode, captured the narrow viewport, reset the viewport, and closed all browser QA tabs.
- Files: `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`
- Decision: The M7 maintenance dialog meets the current desktop and narrow-window layout gate.

### 2026-08-02T23:11:18+08:00 - Automatic M7 gates closed at the human release boundary

- Evidence: 20 test files and 134 tests passed; Rust passed 12 tests. Build, typecheck, lint, formatting, packaged Sidecar, clean NSIS install, and same-installer overwrite checks passed. The final 20,267,507-byte installer has SHA-256 `53341981F0E9FE8EDE55BBF18F6039EDD6063F47D4B9A2BE98E1944283A9AE9E` and Authenticode status `NotSigned`; the signature gate rejected it as intended.
- Commands: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm worker:sidecar`, `pnpm --filter @ai-video/worker validate:m7-sidecar`, `cargo fmt --check`, `cargo check`, `cargo test`, `pnpm tauri:build`, both NSIS validators, and `git diff --check` -> exit `0`. `scripts/validate-windows-signature.ps1` -> expected rejection of the unsigned installer.
- Residual risks: Production Authenticode signing/timestamping, an actual previous-release upgrade, clean Windows VM validation, real network/sleep recovery, authorized real-provider success, and final human release sign-off remain incomplete.
- Rollback: Revert the M7 stage commit; external projects remain outside the installation directory and are not removed by uninstall.
- Decision: Stop automatic work at the documented human boundary. M7 remains `HOLD` and must not be marked complete.

### 2026-08-02T23:16:00+08:00 - Pre-commit ownership race removed

- Evidence: Staged review found that a sample-project `create()` failure before ownership was established could enter recursive cleanup and remove files concurrently created by another process.
- Action: Gated rollback cleanup on successful project-container creation and added a regression test that injects an external marker before the create failure.
- Files: `apps/worker/src/sample-project-service.ts`, `apps/worker/src/sample-project-service.test.ts`
- Commands: focused sample-project test -> exit `0`, 4 tests passed; `pnpm test` -> exit `0`, 20 files and 135 tests passed, including 71 Worker tests.
- Decision: Cleanup remains atomic after this request owns the new project, while pre-ownership failures now fail closed and preserve external content.

### 2026-08-02T23:19:19+08:00 - Corrected release candidate rebuilt and revalidated

- Evidence: The ownership fix changed the packaged Worker, so the 23:11 installer hash is superseded. The current 20,269,548-byte NSIS installer has SHA-256 `A36856A2CAF91F2F054E469404C87CCDEBFF95C93E9DC9C5B1A57C052B0D6712` and remains `NotSigned`.
- Commands: format, lint, typecheck, `pnpm tauri:build`, M7 packaged Sidecar validation, clean NSIS lifecycle, and same-installer overwrite lifecycle -> exit `0` after the fix.
- Decision: This hash identifies the M7 candidate sent to Hosted Windows CI; the release state remains `HOLD` at the same human gates.
