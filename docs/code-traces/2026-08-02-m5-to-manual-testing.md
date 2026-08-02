# Code trace: M5 through manual-testing handoff

- Started: 2026-08-02T02:08:29+08:00
- Repository: `D:\SB\xlngaiforwindows`
- Base revision: `main` at `856e30c`
- Status: in progress

## Objective

按 `docs/IMPLEMENTATION-PLAN.md` 和 `docs/QUALITY-GATES.md` 的阶段顺序，从 M5 生图闭环推进到人工测试入口；记录每个阶段的目标、变更、验证证据和未完成项，不替人工测试或真实成功 Provider 请求签收。

## Baseline

- M0-M4 代码级 P1/P2 已清零。
- GitHub-hosted Windows runner `30711313408` 已通过 TypeScript、Worker、Rust/Tauri、NSIS 构建和干净安装生命周期。
- 当前未配置真实 OpenAI/Vidu 凭据；Vidu 无效令牌官方失败响应为 HTTP `403`；真实成功请求未执行。
- M5 目标：至少一个同步生图适配器、图片资产 manifest/缩略图/镜头关联、脱敏请求快照和厂商错误映射。

## Timeline

### 2026-08-02T02:08:29+08:00 - Baseline and hosted-mode handoff

- Evidence: `main` is clean and tracks `origin/main`; hosted Windows run `30711313408` passed all 15 steps, including `Validate clean NSIS install lifecycle`.
- Action: selected this trace path and confirmed M5/M6/M7 scope from the implementation plan.
- Files: `docs/IMPLEMENTATION-PLAN.md`, `docs/QUALITY-GATES.md`, `scripts/validate-nsis-install.ps1`
- Commands: `git status --short` -> exit `0`; hosted CI run `30711313408` -> `success`.
- Decision: proceed to M5 design and implementation; retain `HOLD` for final release until real successful Provider calls and manual testing.
- Next: freeze M5 use cases, input/output contracts, and failure matrix.

### 2026-08-02T02:35:00+08:00 - M5 use cases and failure matrix frozen
- Evidence: the implementation plan requires a synchronous image-generation loop, local asset manifest, shot association, URL/Base64 validation, timeout/cancel handling, and no partial records on failure.
- Action: defined the first M5 contract around `image.generate`, `asset.list`, `asset.rename`, and `asset.delete`; jobs transition through `pending` -> `running` -> `succeeded` or `failed`/`cancelled`.
- Files: `packages/contracts/src/index.ts`, `packages/domain/src/index.ts`, `packages/persistence/src/schema.ts`, `apps/worker/src/image-generation-service.ts`
- Decision: persist a redacted request snapshot and provider response metadata, download results to a temporary file, verify bytes and content type, atomically rename, then commit the asset/result rows in one SQLite transaction. Any provider, timeout, cancellation, download, or validation failure rolls back the asset row and removes temporary files.
- Next: implement schema/repositories/service, then wire the Worker IPC and desktop submit flow.

### 2026-08-02T02:22:00+08:00 - M5 implementation and automated gates
- Evidence: persistence Schema v4 migration, generation result repository, Worker image service, IPC methods, desktop submit/cancel controls, and M5 documentation are present.
- Action: added atomic temporary-file download and SQLite transaction commit; added asset list/rename/delete; added fixed Base64, invalid response, and HTTP 403 tests.
- Files: `packages/domain/src/index.ts`, `packages/contracts/src/index.ts`, `packages/persistence/src/schema.ts`, `packages/persistence/src/database.ts`, `packages/persistence/src/repositories.ts`, `apps/worker/src/image-generation-service.ts`, `apps/worker/src/handler.ts`, `apps/desktop/src/ProductionPanel.tsx`, `docs/M5-IMAGE-GENERATION.md`, `docs/PROJECT-STARTUP.md`
- Commands: persistence tests -> exit `0` (7 tests); Worker tests -> exit `0` (34 tests); Desktop tests -> exit `0` (6 tests); Worker/Desktop typecheck -> exit `0`; Worker build -> exit `0`.
- Decision: code-level M5 gate is `PASS`; real Vidu success, native Windows network/certificate behavior, and human acceptance remain `HOLD`.
- Next: run repository quality gates, commit, trigger GitHub-hosted Windows CI, then stop at the manual-testing handoff.

### 2026-08-02T02:25:00+08:00 - Local quality gates passed
- Evidence: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` all exited `0`.
- Action: formatted the four new TypeScript files and fixed lint-only unused imports/assertions; updated migration expectations to Schema v4.
- Decision: local code gate is `PASS`; native Rust/Cargo and NSIS remain hosted-only checks in this environment.
- Next: commit and push the M5 implementation, then await the hosted Windows result.

### 2026-08-02T02:47:00+08:00 - Hosted Windows gate passed and manual handoff prepared
- Evidence: GitHub-hosted Windows run `30712459268` completed with `success`; TypeScript workspace, sidecar build, `cargo check`, NSIS bundle, and clean install lifecycle all passed.
- Action: added controlled asset-kind selection plus post-success asset refresh and in-panel rename/delete controls; preserved existing desktop initialization contract after the first test run exposed unsupported eager `asset.list` calls.
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` -> exit `0` after the UI adjustment.
- Decision: code and hosted release gates are `PASS`; real Vidu success, real credential read, and human UI acceptance remain `HOLD`.
- Next: stop implementation at the documented manual-testing entry; do not start M6 until manual results are recorded.

### 2026-08-02T02:59:00+08:00 - Stopped at manual-testing entry
- Evidence: final commit `3ced94a` hosted Windows run `30713323059` completed with `success`; all local quality gates and final UI asset-management changes are verified.
- Action: stopped implementation at the M5 manual-test handoff as requested.
- Decision: M5 code/hosted gates are `PASS`; release and stage sign-off remain `HOLD` until a human performs real Vidu success, credential, asset persistence, failure, and restart checks.
- Next: execute the checklist in `docs/M5-IMAGE-GENERATION.md`; record human outcomes before considering M6.

### 2026-08-02T03:12:00+08:00 - Automated manual-test continuation started
- Evidence: user explicitly requested automatic completion of subsequent operations after the manual-test handoff.
- Action: reopened this trace and began Windows desktop UI automation for the M5 acceptance checklist.
- Decision: automate installation/startup/UI/failure/restart paths; never fabricate a real successful Vidu request or expose credentials. Any paid/credentialed success remains `HOLD` when no credential is configured.
- Next: locate the final executable, launch it, and execute the safe M5 UI checks.

### 2026-08-02T05:18:00+08:00 - Safe UI acceptance exposed an orphaned image job

- Evidence: the browser-driven desktop UI created `D:\SB\xlngaiforwindows-m5-ui-test`, one scene, one shot, and a valid Vidu draft. Empty prompt submission was rejected, the valid `9:16`/`2K` draft survived project close/reopen, and the non-Tauri page refused Provider submission through the documented secure-transport boundary.
- Evidence: read-only SQLite inspection returned `integrity_check=ok`, no foreign-key violations, `generation_results=0`, and `assets=0`, but the prepared job remained `running` after the secure transport threw.
- Action: changed the M5 acceptance result to `FAIL` because an asynchronous task did not reach a terminal state.
- Decision: do not sign M5 or continue to M6 until transport failure, project close/switch, Worker restart, and cancellation-during-download are terminal and regression-tested.
- Next: add an explicit transport-failure transition, close/switch cancellation, restart recovery, and project-session checks.

### 2026-08-02T05:26:00+08:00 - Image job terminalization fixed and retested

- Evidence: added `image.generate.fail`; project close/switch now terminalizes active image jobs as `cancelled`; writable project reopen repairs interrupted jobs as `failed`; completion rechecks the exact project session and current job state after image download.
- Action: fixed all M5 asset-management mojibake discovered during UI inspection and cleared stale generation errors when parameters change.
- Files: `packages/contracts/src/index.ts`, `apps/worker/src/image-generation-service.ts`, `apps/worker/src/handler.ts`, `apps/desktop/src/ProductionPanel.tsx`, their focused tests, and `docs/M5-IMAGE-GENERATION.md`.
- Commands: Worker image-service tests -> exit `0` (7 tests); Worker full tests -> exit `0` (38 tests); Desktop production-panel tests -> exit `0` (4 tests); Worker/Desktop typecheck -> exit `0`.
- Evidence: after a real Worker restart and a second safe UI failure, SQLite contained two `failed` jobs (`interrupted` recovery and `transport failed`), zero results, zero assets, `integrity_check=ok`, and no foreign-key violations. The draft still contained the original prompt, `9:16`, and `2K` values.
- Decision: the discovered state-machine `P1` and UI encoding defect are fixed. Real Vidu success and Windows Credential Manager use remain `HOLD`; the browser failure test is not represented as native Provider success.
- Next: run full local gates, commit and push, wait for hosted Windows CI, then record the remaining manual/credentialed boundary.

### 2026-08-02T05:31:00+08:00 - Full local release gates passed

- Evidence: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` exited `0`; the first full run passed 13 test files and 73 tests.
- Evidence: Worker Sidecar build and M4 lifecycle validation passed with five adapters, exact v2 resolution, invalid-combination rejection, credential exclusion, and draft round-trip.
- Evidence: `cargo fmt --check`, `cargo check --offline`, and `cargo test --offline` passed through the installed Rust toolchain; seven Rust tests passed.
- Evidence: `pnpm tauri:build` produced the 20,210,990-byte x64 NSIS bundle with SHA-256 `1D64DA3EC984F7458383370A3B76CFA83FB6D8F9805BB96EEEF4BD13B75B51EA`.
- Evidence: `scripts/validate-nsis-install.ps1` passed silent clean install, desktop/Worker startup and SQLite survival, graceful desktop close, Worker cleanup, silent uninstall, and installed-binary removal.
- Decision: local code, native, package, and install gates are `PASS`; hosted Windows CI is required for the final code revision. Real credentialed Provider success and human visual acceptance remain `HOLD`.
- Next: perform final diff/security review, commit and push, then wait for the hosted workflow result.

### 2026-08-02T05:34:00+08:00 - Final diff review closed the asset-reload gap

- Evidence: persisted assets were only refreshed after a successful generation in the current React session; reopening a project left the production-panel list empty even though SQLite and files were intact.
- Action: keyed asset loading by persistent project ID, cleared stale project assets during switches, and preserved the explicit cancelled status after a Provider request returns. Added a desktop regression test for reopening a project with an existing asset.
- Files: `apps/desktop/src/App.tsx`, `apps/desktop/src/ProductionPanel.tsx`, `apps/desktop/src/ProductionPanel.test.tsx`.
- Decision: the M5 reopen-and-confirm workflow is now represented in the UI and automated tests. Re-run all gates because the final release inputs changed.
- Next: repeat local tests/build/package checks, then commit and push.

### 2026-08-02T05:39:00+08:00 - Final local gates passed after asset reload

- Evidence: final `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` runs passed; 13 test files and 74 tests passed, including eight Desktop tests and 38 Worker tests.
- Evidence: final `pnpm tauri:build` rebuilt the Sidecar and produced a 20,212,345-byte x64 NSIS installer with SHA-256 `12B64D57F78C9C7FF02D5754F8C9913954C2FEF8ED2C5975EF89183531C50829`.
- Evidence: the final installer again passed clean install, startup/SQLite survival, graceful close, Worker cleanup, silent uninstall, and installed-binary removal.
- Decision: all locally executable code, state-machine, native, package, and clean-install gates are `PASS`. Hosted CI remains pending; real Vidu/OpenAI success and human visual acceptance remain `HOLD`.
- Next: commit and push the reviewed revision, then wait for GitHub-hosted Windows CI.

### 2026-08-02T05:52:00+08:00 - Hosted success rejected because CI masked an earlier failure

- Evidence: GitHub run `30719653108` displayed `Success` for commit `580b603`, but its public summary retained ten TypeScript/Lint error annotations from the clean checkout. The workflow executed five native commands inside one PowerShell step, so the last successful command could mask an earlier non-zero exit code.
- Action: split format, build, lint, typecheck, and test into independent Actions steps. Build now precedes typed Lint so workspace declaration outputs exist in a clean checkout. Upgraded checkout, Node setup, and pnpm setup actions to their verified v6 tags to remove the Node 20 action-runtime warning.
- Files: `.github/workflows/ci.yml`.
- Decision: run `30719653108` is not accepted as quality-gate evidence despite its green badge. A new hosted run with fail-fast steps must pass before recording `PASS`.
- Next: commit and push the CI correction, then monitor the replacement run to completion.

### 2026-08-02T06:05:00+08:00 - Fail-fast hosted CI passed; automation stopped at external boundary

- Evidence: GitHub Windows run `30720119063` completed with `Success` for commit `8831c2b`; the `validate` job completed successfully in 11m 7s, total duration was 11m 10s, and the public annotation region was empty.
- Evidence: independent workflow steps passed formatting, TypeScript build, Lint, typecheck, 74 tests, standalone Sidecar, Cargo/Tauri, NSIS packaging, and the clean install/start/SQLite/close/uninstall lifecycle.
- Action: accepted the hosted gate after confirming earlier command failures can no longer be masked by a later success.
- Decision: all safe and automatable M5 code, UI failure/restart, persistence, native, package, install, and hosted gates are `PASS`. Real Vidu success, real OpenAI success, Windows credential entry/use, and human visual/interaction acceptance remain explicitly `HOLD`/unverified because no credential or quota authorization was provided.
- Decision: do not begin M6 and do not sign M5 as fully accepted until the human checklist in `docs/M5-IMAGE-GENERATION.md` records those outcomes.
- Next: a human supplies authorized test credentials and performs the remaining real Provider and visual acceptance checklist; record results before changing this trace from `stopped`.

### 2026-08-02T08:20:00+08:00 - Real Provider click reported no visible result

- Evidence: the running release window was currently on `No project open`; the Generate button was disabled and the project database had one project, zero shots, zero generation jobs, zero results, and zero assets. No new credential or request body was read.
- Investigation: the Vidu reference-to-image API documents an asynchronous contract: the POST returns a `task_id` and `state`, while the image URLs are returned by `GET /ent/v2/tasks/{id}/creations`. The native bridge only performed the POST and returned immediately; the Worker then looked for an image URL in the creation response and could never persist a normal Vidu task result.
- Decision: keep M5 blocked and patch the native bridge to poll the documented task endpoint with a bounded timeout, validate the task id before constructing the path, and surface failed/timeout states as terminal UI errors. Do not issue another real request until the rebuilt binary and regression tests pass.
- Next: implement the bounded Provider task polling, add native tests, rebuild, and re-run safe gates.

### 2026-08-02T09:18:00+08:00 - Bounded Vidu polling implemented and safe gates passed

- Action: refactored the native WinHTTP bridge to support POST and GET, poll Vidu task creations for up to 120 seconds, reject unsafe task IDs, require image output on success, and map terminal Provider failures/timeouts to UI-visible errors.
- Files: `apps/desktop/src-tauri/src/lib.rs`, `docs/M5-IMAGE-GENERATION.md`.
- Verification: Rust offline tests passed (9); `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (74 tests), `pnpm build`, and `git diff --check` passed. Release Tauri/NSIS build succeeded and clean install lifecycle passed (`WorkerStarted`, startup checks, graceful close, Worker cleanup, uninstall, and binary removal all true).
- Safety: no credential value, request body, or Provider response containing user data was read or logged; no additional real Provider request was sent. The rebuilt Release app was relaunched after the install check and is running with Worker PID 28080; the UI health/SQLite indicators are normal.
- Decision: the asynchronous Provider contract defect is fixed in code, but M5 real credentialed success and human acceptance remain `HOLD`; do not sign the stage or start M6 until the user performs one controlled real request and records the outcome.
- Next: use the rebuilt app for one authorized real Vidu test, then verify the asset file/manifest and failure/retry behavior without exposing the key.

### 2026-08-02T09:31:00+08:00 - Hosted Windows gate passed for the polling fix

- Evidence: GitHub Actions run `30726901221` for commit `03b5456` completed with `completed successfully`; the `validate` job was successful and the rendered Annotations region was empty.
- Decision: hosted code/native/package/install gates remain `PASS`. Real Vidu credentialed success, asset persistence from a real result, and human visual acceptance remain `HOLD` and are the only M5 acceptance boundary still open.
- Next: perform one controlled real request in the rebuilt app only when authorized; record terminal status and asset/manifest evidence without recording the API key.

### 2026-08-02T09:47:00+08:00 - Empty project path validation fixed

- Evidence: clicking the left-side project action with an empty path sent an empty value to Worker and displayed `rootPath must be a string.`; the topbar actions were already disabled, but the left-side actions were not.
- Action: normalized project name/path before IPC, added clear client-side validation, and disabled left-side `New`/`Open` buttons until the required absolute path (and project name for New) is present. Added a Desktop regression test.
- Files: `apps/desktop/src/App.tsx`, `apps/desktop/src/App.test.tsx`.
- Verification: Desktop tests passed (9); workspace format/lint/typecheck passed; Release Tauri/NSIS build passed; clean install lifecycle passed; rebuilt Release UI confirmed both left-side actions disabled for an empty path.
- Decision: the invalid IPC error path is fixed. Real Provider success and human M5 acceptance remain `HOLD`.

### 2026-08-02T10:06:30+08:00 - Hosted test failure traced to native ABI cache
- Evidence: Hosted run `30727633358` passed formatting, build, lint, and typecheck, then failed only at `Test TypeScript workspace`; the public check annotation contained only the generic exit-code failure. Local `pnpm test` passed under Node `26.5.0`.
- Experiment: reproducing the test command under Node `24.18.1` failed all seven persistence tests with `better_sqlite3.node` compiled for `NODE_MODULE_VERSION 147` while Node 24 requires `137`.
- Action: updated `.github/workflows/ci.yml` to resolve `better-sqlite3` and its `prebuild-install` executable from the workspace, then install the prebuilt binary after dependency installation using the active CI Node runtime.
- Verification: the same Node 24 prebuild command installed `better-sqlite3-v12.11.1-node-v137-win32-x64` and the persistence test passed (7 tests). The workflow fix is ready for a fresh hosted run.
- Decision: the Hosted failure was an environment/cache ABI mismatch, not an application regression. Do not accept run `30727633358`; wait for the replacement run before changing the stage gate.
- Next: run the local checks affected by the workflow edit, commit/push the CI fix, and verify a new Hosted Windows run.

### 2026-08-02T10:09:38+08:00 - Native ABI fix passed local gates
- Evidence: after installing the Node ABI 137 prebuild, the complete Node `24.18.1` workspace run passed 13 test files and 74 tests. After restoring the ABI 147 prebuild for the local Node `26.5.0` runtime, build, lint, typecheck, and the same 74 tests passed.
- Verification: `pnpm format:check`, `pnpm worker:sidecar`, `cargo fmt --check`, `cargo check --offline`, `cargo test --offline` (9 Rust tests), and `git diff --check` passed.
- Decision: the workflow change is locally verified across the exact CI Node major and the developer runtime. It is ready to commit and push; Hosted Windows remains the required final check.
- Next: push the CI correction and monitor the replacement workflow through NSIS lifecycle completion.

### 2026-08-02T10:32:00+08:00 - Domestic Vidu routing and CI resolver implemented
- Evidence: the reported HTTP 401 came from a domestic Vidu key being sent to the fixed international host; the existing native command also had no region parameter. Hosted CI used PowerShell `.Trim()` around `pnpm exec` output and failed before validation.
- Action: added a Rust allowlist for `global` and `cn` regions, fixed hosts `api.vidu.com`/`api.vidu.cn`, separate Credential Manager targets `vidu`/`vidu-cn`, raw-key prefix rejection, a React region selector, and a bounded provider-client region parameter. Added a clear HTTP 401 region/key message and replaced the CI PowerShell resolver with `scripts/align-native-node-runtime.mjs` using `createRequire` and the active Node runtime.
- Files: `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/provider-client.ts`, `apps/desktop/src/ProductionPanel.tsx`, `apps/worker/src/image-generation-service.ts`, `scripts/align-native-node-runtime.mjs`, `.github/workflows/ci.yml`.
- Verification: Desktop tests passed (9); Worker tests passed (39) on the rerun; workspace typecheck and build passed; the resolver installed the active Node 26 ABI prebuild; `git diff --check` passed. Cargo is unavailable in this local shell and remains Hosted-only.
- Decision: domestic routing is safe to test after a new hosted build; no API key or real Provider request was read or sent. M5 real success and human acceptance remain `HOLD`.
- Next: run the complete local gates, commit/push, confirm Hosted Windows CI, then ask the user to select `China site (api.vidu.cn)`, save the raw domestic key, and perform one controlled real request.

### 2026-08-02T10:35:00+08:00 - Local gate rerun completed
- Evidence: the first parallel `worker:sidecar` attempt hit a transient Windows `EBUSY` while replacing `better_sqlite3.node`; a serial rerun completed and produced the sidecar successfully.
- Verification: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (13 files, 74 tests), `pnpm build`, `pnpm worker:sidecar`, and `git diff --check` passed. Cargo remains unavailable locally.
- Decision: all locally executable TypeScript/Worker/package gates are `PASS`; native Rust/Tauri/NSIS gates remain pending Hosted Windows. No real Provider request was sent.
- Next: commit and push the domestic-region and CI fix, then verify the Hosted run before manual testing.

### 2026-08-02T10:45:00+08:00 - Domestic routing passed Hosted Windows
- Evidence: GitHub Actions run `30729007558` for commit `d079ffa` completed successfully. The hosted sequence passed the Node ABI alignment script, formatting, TypeScript build/Lint/typecheck, 74 tests, standalone Worker build, Rust/Tauri check, NSIS bundle, and clean install lifecycle.
- Decision: code, native, package, install, and Hosted gates for the domestic Vidu routing fix are `PASS`. M5 remains `HOLD` only for one authorized real request and human visual/interaction acceptance.
- Next: in the rebuilt app select `China site (api.vidu.cn)`, save the raw domestic API key without an authorization prefix, perform one controlled generation, and record the terminal job/asset outcome without recording the key.

### 2026-08-02T11:08:00+08:00 - Generic image failure diagnosed
- Evidence: the visible desktop error was only `图片生成失败。`; the current region credential status was `未配置`. The active project database contained a prior HTTP 401 followed by two terminal transport failures and no assets. No credential value or request payload was read.
- Evidence: Tauri command rejections are strings, while `ProductionPanel` only surfaced `Error` instances; the actual `Provider credential is not configured` message was replaced by the generic fallback. Region selection also reset to the international site on each fresh session.
- Action: normalized string/object/Error rejection messages, defaulted new sessions to the China site, persisted the region preference, cleared unsaved key input when switching regions, and blocked generation until the selected region credential status is configured.
- Files: `apps/desktop/src/ProductionPanel.tsx`, `apps/desktop/src/ProductionPanel.test.tsx`.
- Decision: this is a UI error-reporting and region-state defect, not evidence of a failed domestic image task. Real domestic Provider success remains `HOLD`; the user must save the raw key in the China-region credential slot and retry once after the updated build passes.
- Next: run local and Hosted gates, then hand off one controlled domestic request.

### 2026-08-02T11:12:00+08:00 - Credential/region guard passed local gates
- Verification: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (13 files, 77 tests), `pnpm build`, focused Desktop tests (10), and `git diff --check` passed.
- Evidence: the restarted desktop exposes the Chinese Vidu region control, defaults to the China credential slot, reports it as unconfigured, and did not issue a Provider request during inspection.
- Decision: the UI guard and error visibility fix are ready for Hosted Windows verification. M5 remains `HOLD`; a real request is still intentionally not automated.
- Next: commit/push, verify Hosted CI, then ask the user to open the project, save the raw key under `中国站`, and retry once.

### 2026-08-02T11:22:00+08:00 - Credential/region guard passed Hosted Windows
- Evidence: GitHub Actions run `30730154927` for commit `3e9156d` completed with `success`; formatting, TypeScript build/Lint/typecheck, 77 tests, Worker Sidecar, Rust/Tauri check, NSIS bundle, and clean install lifecycle all passed.
- Decision: automated code/native/package/install gates are `PASS`. M5 remains `HOLD` only for the real domestic Provider result and human visual acceptance.
- Next: the user opens `D:\ts`, confirms `中国站 (api.vidu.cn)`, saves the raw domestic API Key in the selected region slot, and manually runs one generation. Record the exact visible terminal result without recording the key.

### 2026-08-02T12:14:24+08:00 - Domestic Vidu result download failure diagnosed
- Evidence: the user-visible generation error was `fetch failed`. Read-only SQLite inspection of `D:\ts\project.sqlite` showed the two latest `TEXT_TO_IMAGE:vidu:viduq2:v2` jobs ended as `failed` with `{"message":"fetch failed"}` after earlier 401 and transport failures. No credential value, Provider response body, or full signed result URL was read or recorded.
- Experiment: `node fetch('https://api.vidu.cn')` returned HTTP 404, so the domestic API host is reachable. A representative Vidu domestic object-storage host produced Node `fetch failed` with cause `ECONNRESET`, matching the generic UI failure class.
- Action: tightened native polling completion to require image output under Provider `creations` fields instead of any arbitrary HTTP string, preventing echoed input URLs from ending polling early. Tightened Worker result extraction to prefer embedded data and `creations[].url`/`uri`/image fields before legacy HTTP fallback. Added Worker download diagnostics that persist only the host and network cause, not signed query strings.
- Files: `apps/desktop/src-tauri/src/lib.rs`, `apps/worker/src/image-generation-service.ts`, `apps/worker/src/image-generation-service.test.ts`.
- Verification: focused Worker image tests passed (10). `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (13 files, 79 tests), `pnpm build`, `pnpm worker:sidecar`, and `git diff --check` passed. The first sidecar attempt failed with `EBUSY` while the old dev desktop/Worker still held `better_sqlite3.node`; after stopping only the project `tauri dev`, Vite, `ai-video-desktop.exe`, and Worker Node processes, the sidecar build passed. Local `cargo`/`rustfmt` remain unavailable in this Codex shell, so native Rust validation must be covered by Hosted Windows.
- Decision: M5 remains `HOLD`. This patch fixes output URL selection and makes the next real failure actionable; it does not yet prove the real domestic result URL can be downloaded on the user's network.
- Next: commit/push, verify Hosted Windows native/package gates, then restart `pnpm dev:desktop` and perform one controlled domestic generation. If it still fails, the UI/database should show the concrete result host and cause such as `ECONNRESET`, `ETIMEDOUT`, DNS, or TLS.

### 2026-08-02T12:28:44+08:00 - Hosted Windows gate passed for download diagnostics
- Evidence: GitHub Actions run `30732119587` for commit `1c0782c` completed with `success`. Step status showed formatting, TypeScript build/lint/typecheck, 79 tests, standalone Worker, `cargo check`, Tauri/NSIS bundle, and clean install lifecycle all completed successfully.
- Decision: automated code, native, package, install, and Hosted gates are `PASS` for the output extraction and download diagnostics patch. M5 remains `HOLD` for the real domestic result download and human visual acceptance.
- Next: restart the dev desktop from `main`, open `D:\ts`, keep `China site (api.vidu.cn)`, and run one controlled generation. If it still fails, record the new host/cause error without recording the API key or full signed URL.

### 2026-08-02T13:21:38+08:00 - Local asset save and preview workflow implemented
- Evidence: the user confirmed that closing the proxy made domestic Vidu image generation work; the prior `ECONNRESET` path is therefore an environment/proxy interaction, not a reason to automate proxy changes.
- Action: added the optional `自动保存到本地素材库` toggle (default on and remembered when local storage is available), preview data on generation completion, registered-asset preview loading, one-click reveal through the native file manager, and asset-library navigation. A successful save refreshes the project asset list and preserves the selected asset kind (`generated-image`, `character`, `scene`, `first-frame`, or `last-frame`).
- Files: `packages/contracts/src/index.ts`, `apps/worker/src/handler.ts`, `apps/worker/src/image-generation-service.ts`, `apps/worker/src/image-generation-service.test.ts`, `apps/desktop/src/ProductionPanel.tsx`, `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`, `apps/desktop/src/ProductionPanel.test.tsx`.
- Verification: focused Worker tests passed (12); focused Desktop tests passed (12). After an initial `format:check` failure on the three edited TypeScript files, Prettier was run and the gate was rerun successfully. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm worker:sidecar`, and `git diff --check` all passed. No real Provider request was issued.
- Decision: the local code path for optional save, preview, reveal, and material-library discovery is ready for Hosted Windows verification and human UI testing. M5 remains `HOLD` for real credentialed success, actual downloaded output, and human acceptance.
- Next: commit/push this revision, verify Hosted Windows Rust/Tauri/NSIS gates, then manually generate once with the proxy state that the user has validated and confirm preview, file-manager reveal, selected asset kind, and material-library presence.

### 2026-08-02T13:25:39+08:00 - Asset IPC input validation tightened
- Action: changed `asset.preview` and `asset.reveal` handler routing to require a non-empty string `assetId` at the IPC boundary, and added a regression test for invalid input.
- Files: `apps/worker/src/handler.ts`, `apps/worker/src/handler.test.ts`.
- Verification: Worker suite passed (44 tests), `pnpm format:check`, `pnpm typecheck`, and `git diff --check` passed.
- Decision: keep the feature within M5 and preserve the manual/real-Provider `HOLD`; no real request or credential was accessed.

### 2026-08-02T13:40:16+08:00 - Hosted Windows gate passed for local asset preview flow
- Evidence: GitHub Actions run `30734207680` for commit `b0f35a5` completed with `success`. Step status showed formatting, TypeScript build/lint/typecheck, 84 tests, standalone Worker build, Rust/Tauri check, NSIS bundle, and clean install lifecycle completed successfully.
- Decision: automated code, native, package, install, and Hosted gates are `PASS` for the optional local-save/preview/reveal/material-library flow. M5 remains `HOLD` only for human confirmation of the real generated image preview, file-manager reveal, selected asset kind, material-library presence, and any further real Provider acceptance checks.
- Next: restart the desktop from `main`, open the target project, keep the proxy state that allowed the successful domestic download, generate once with auto-save enabled, then repeat once with auto-save disabled to confirm preview-only behavior.

### 2026-08-02T14:51:35+08:00 - Preview-only manual save implemented
- Evidence: the user clarified that `保存为角色/场景/首帧/尾帧` needs an explanation and that disabling automatic local save should still allow a later explicit save action.
- Action: added shared `ImageAssetKind`, a new `image.generate.savePreview` Worker method, preview data validation, IPC asset-kind whitelisting, and a `保存到素材库` button that appears only for generated previews that have not yet been persisted. Manual save writes the preview image to `assets/images/`, creates the generation result manifest, refreshes the asset list, and selects the saved asset.
- Files: `packages/contracts/src/index.ts`, `apps/worker/src/image-generation-service.ts`, `apps/worker/src/handler.ts`, `apps/desktop/src/ProductionPanel.tsx`, `apps/desktop/src/styles.css`, focused tests.
- Verification: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, focused Worker tests (19), focused Desktop production-panel tests (8), `pnpm test` (84 tests), `pnpm build`, `pnpm worker:sidecar`, and `git diff --check` passed. The first sidecar run hit the known Windows `better_sqlite3.node` `EBUSY` lock while project dev processes were still running; after stopping only the project `tauri dev`, Vite, esbuild, and `ai-video-desktop.exe` processes, a serial sidecar rerun passed.
- Decision: the requested UI behavior is implemented in M5 scope. Real Provider/manual acceptance remains `HOLD`; no real request or credential was accessed.

### 2026-08-02T15:05:36+08:00 - Hosted Windows gate passed for preview-only manual save
- Evidence: GitHub Actions run `30736751960` for commit `9263e48` completed with `success`.
- Verification: Hosted Windows passed formatting, TypeScript build/lint/typecheck, workspace tests, standalone Worker build, Rust/Tauri check, NSIS bundle, and clean NSIS install lifecycle.
- Decision: automated code, native, package, install, and Hosted gates are `PASS` for the preview-only manual save flow. M5 remains `HOLD` for human confirmation in the real desktop UI and any further credentialed Provider acceptance checks.
- Next: restart the desktop from `main`; generate once with automatic local save disabled, confirm preview-only behavior, then click the manual save button and verify that the selected asset kind appears in the project asset library.
