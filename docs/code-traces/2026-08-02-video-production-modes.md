# Code trace: complete video production modes

- Started: 2026-08-02T18:40:00+08:00
- Repository: `D:\SB\xlngaiforwindows`
- Base revision: `main` at `b490507`
- Status: complete

## Objective

Expose text-to-video, image-to-video, reference-to-video, and start/end-frame-to-video as distinct production modes, while preserving recovery of jobs created with legacy video adapter keys and retaining the existing secure native Provider boundary.

## Baseline

- The catalog exposed only `TEXT_TO_IMAGE`, `REFERENCE_TO_IMAGE`, and `IMAGE_TO_VIDEO`.
- Reference-to-video, start/end-frame-to-video, and image-to-video were grouped under one `IMAGE_TO_VIDEO` option and distinguished only by model selection.
- Text-to-video had no contract, adapter, native allowlist entry, or UI option.
- A prior real reference-to-video job exists under a legacy `IMAGE_TO_VIDEO:vidu:viduq3:v2` key, so removing that lookup would break restart recovery and task history.

## Timeline

### 2026-08-02T18:44:00+08:00 - Official contract verified

- Evidence: Vidu's public Text to Video documentation returned HTTP 200 and declares `POST /ent/v2/text2video`; `viduq3-pro` accepts a required prompt up to 5,000 characters, duration 1-16 seconds, 540p/720p/1080p, audio, seed, aspect ratio, and off-peak mode.
- Evidence: the same public documentation states off-peak tasks may take up to 48 hours.
- Decision: add one conservative Vidu Q3 Pro text-to-video adapter and do not expose ineffective or pass-through fields such as `style`, `movement_amplitude`, `bgm`, `payload`, or `callback_url`.
- Decision: introduce distinct current adapter keys for reference-to-video and start/end-frame-to-video, but retain their previous keys as lookup-only compatibility adapters excluded from the UI catalog.
- Next: update design documents and then implement contracts, adapters, Worker/native boundaries, UI, and tests in that order.

### 2026-08-02T19:43:18+08:00 - Six production modes implemented

- Action: expanded the generation capability contract with text-to-video, reference-to-video, and start/end-frame-to-video; registered a Vidu Q3 Pro text-to-video schema; split current reference and start/end adapters into distinct catalog entries; and retained the previous keys as lookup-only compatibility adapters.
- Action: updated Worker image/video service boundaries, the Rust native adapter/field allowlist, and Desktop video routing. The production selector now has six stable options: text-to-image, reference-to-image, text-to-video, image-to-video, reference-to-video, and start/end-frame-to-video.
- Evidence: focused adapter tests passed 9/9, Worker image/video tests passed 25/25, Desktop production panel tests passed 14/14, and Rust tests passed 12/12.
- Files: `packages/contracts/src/index.ts`, `packages/generation-adapters/src/index.ts`, `apps/worker/src/video-generation-service.ts`, `apps/worker/src/image-generation-service.ts`, `apps/desktop/src/ProductionPanel.tsx`, `apps/desktop/src-tauri/src/lib.rs`
- Decision: use one shared asynchronous video state machine for all four video production capabilities; endpoint and parameter differences remain fixed by the exact adapter key.

### 2026-08-02T19:51:21+08:00 - Local integration and sidecar gates passed

- Evidence: full build and typecheck passed; all 17 TypeScript test files and 119 tests passed. Lint and format checks passed after removing one unnecessary test assertion and applying repository formatting.
- Evidence: direct Worker IPC returned seven current adapters and six distinct production modes, with legacy video keys absent from the UI catalog. The rebuilt packaged sidecar passed its isolated lifecycle with seven adapters, invalid-combination rejection, draft round-trip, and credential exclusion.
- Evidence: the first sidecar build was blocked by `EBUSY` while the development Worker held `better_sqlite3.node`; stopping only the Worker was insufficient because the desktop restarted it. The verified `pnpm dev:desktop` process tree was stopped, the sidecar gate then passed, and the development app was restarted with its existing Cargo directory scoped into that process environment.
- Runtime: Vite is listening on `http://127.0.0.1:1420`; the Tauri desktop and Worker processes are running again.
- Decision: no Provider request was sent. Real text-to-video, image-to-video, and start/end-frame-to-video success paths remain at the human-test boundary; the previously reported real reference-to-video task already completed successfully and produced a valid local MP4 asset.
- Next: run the final local gate after documentation updates, commit and push, then require Hosted Windows success before human testing.

### 2026-08-02T19:55:00+08:00 - Release and clean-install gates passed

- Evidence: the final full local gate passed build, typecheck, 17 TypeScript test files/119 tests, lint, format check, Rust format check, and 12 Rust tests.
- Evidence: `pnpm tauri:build` produced the x64 NSIS installer at 20,265,481 bytes with SHA-256 `82186147F8124452DFB88CB69B8A04ED7479319FE096B48D4CB0D2D7B1E4CFCB`.
- Evidence: the clean NSIS lifecycle passed isolated installation, installed Worker startup, startup-check survival, graceful desktop close, Worker exit, uninstall, and binary cleanup.
- Environment: release prebuild initially encountered the same development-Worker `EBUSY`; after stopping the verified development process tree it completed. The Tauri development app, Worker, and Vite server were then restarted successfully.
- Decision: all required local automated and release gates are `PASS`; Hosted Windows remains pending.
- Next: commit and push the reviewed changes, wait for Hosted Windows, and stop at the manual Provider validation boundary.

### 2026-08-02T20:13:30+08:00 - Q3-Drama contract and model naming verified

- Evidence: the supplied Vidu announcement names the product `Vidu Q3-Drama`; its linked request documentation defines model ID `viduq3-drama` on `POST /ent/v2/reference2video` with 1–7 images, 2–15 seconds, 720p/1080p, 9:16 or 16:9, and audio output support.
- Evidence: `v2` is the API path/version segment and is already stored separately as `apiVersion`; the Desktop model selector currently appends it to `modelLabel`, while the adapter metadata also displays it separately.
- Action: updated the M4/M6 contracts before implementation to require exact official model labels, separate API-version display, and the Q3-Drama parameter boundary.
- Files: `docs/M4-ADAPTERS-PARAMETERS.md`, `docs/M6-VIDEO-POLLING.md`
- Decision: add `viduq3-drama` as a new `REFERENCE_TO_VIDEO` adapter and keep `apiVersion: v2` in its full adapter key and metadata, not in the displayed model name.
- Next: update the Registry, native Provider allowlist, Desktop selector, and focused tests.

### 2026-08-02T20:33:21+08:00 - Q3-Drama integration and release gates passed

- Action: added the `REFERENCE_TO_VIDEO:vidu:viduq3-drama:v2` adapter, exact official product labels, separate API-version display, native fixed-route/model injection, explicit sidecar coverage, and the missing generation-adapters build step in `dev:desktop` startup.
- Evidence: build and typecheck passed; all 17 TypeScript test files and 120 tests passed; lint, format check, Rust format check, and all 12 Rust tests passed.
- Evidence: the rebuilt packaged sidecar returned eight current adapters, resolved the exact Q3-Drama key and label, accepted its valid 8-second/1080p request, and rejected a 16-second request.
- Evidence: Tauri release build produced an x64 NSIS installer at 20,259,723 bytes with SHA-256 `5AA3128D74AC3BC7BFEC6358D10168AF9F045BAED319BE7A5548FA453F43C329`; isolated install, Worker startup, graceful close, Worker exit, uninstall, and binary cleanup all passed.
- Evidence: the restarted desktop is responsive with Worker PID 16288 and Vite listening at `http://127.0.0.1:1420`; the Tauri WebView displays the model product name separately from `API v2`.
- Environment: the first sidecar rebuild was blocked by `EBUSY` while the development Worker held `better_sqlite3.node`; the verified development process tree was stopped, the sidecar and release gates then passed, and the development app was restarted.
- Files: `packages/generation-adapters/src/index.ts`, `apps/desktop/src/ProductionPanel.tsx`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/worker/scripts/validate-m4-sidecar.mjs`
- Decision: optional audio-reference files from the supplied API document remain outside this change because the current local-input and persistence-redaction boundary is image-specific; Q3-Drama itself is usable with one to seven image references and all verified core generation fields.
- Next: commit and push the local changes, wait for Hosted Windows, and stop before any real credentialed Provider request.

### 2026-08-02T20:47:03+08:00 - Hosted Windows gate passed

- Evidence: GitHub Actions run `30748123116` for commit `0d6cffc` completed successfully; the Hosted Windows job passed formatting, build, lint, typecheck, all tests, standalone Worker build, Tauri host checks, NSIS build, and clean NSIS install lifecycle validation.
- Evidence: local `main` and `origin/main` both contain the implementation commit; the development desktop remains running after release verification.
- Decision: automated implementation and release validation are complete. No real credentialed Provider request was sent, so the remaining Q3-Drama success-path check is an explicit human test that may consume credits.
- Rollback: revert `0d6cffc` to remove Q3-Drama and restore the prior model-label presentation while preserving the preceding video-mode implementation.
