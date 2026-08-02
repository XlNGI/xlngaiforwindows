# Code trace: video polling stall diagnosis

- Started: 2026-08-02T18:29:00+08:00
- Repository: `D:\SB\xlngaiforwindows`
- Base revision: `main` at `b490507`
- Status: complete

## Objective

Determine whether the current reference-to-video task is stuck in local polling, without issuing, cancelling, or repeating any Provider request and without exposing credentials, request content, task IDs, or signed result URLs.

## Baseline

- The Tauri desktop, Worker, and Vite processes were still running from the same development session.
- Startup logs contained no crash or restart after the desktop application launched.
- Only bounded task state, timestamps, sanitized metadata, and local result integrity were inspected.

## Timeline

### 2026-08-02T18:29:12+08:00 - Active project and polling persistence confirmed

- Evidence: the active project lock belonged to the live Worker process; its SQLite WAL was updated while the reported task was running.
- Evidence: the latest video task used `IMAGE_TO_VIDEO:vidu:viduq3:v2`, the China region, normal mode (`off_peak=false`), and had a Provider task ID.
- Action: queried the active project database in strict read-only mode without selecting `request_json`, Provider responses, credentials, URLs, or full task IDs.
- Decision: the scheduler and Worker persistence path were active; this was not a stopped-process or detached-project case.

### 2026-08-02T18:36:21+08:00 - Provider completion and local asset verified

- Evidence: task `abbb5dab...` changed from submission at `2026-08-02T18:18:48+08:00` to `succeeded` at `2026-08-02T18:26:57+08:00` after 18 polls, for an elapsed time of about 8 minutes 9 seconds.
- Evidence: the final Provider state was `success`; there was no failure kind or persisted error. The normal 30-minute deadline had not expired.
- Evidence: one generation result and one `shot-video` asset were registered. The MP4 exists locally, its size matches SQLite at 4,819,257 bytes, and its file signature is valid.
- Evidence: an earlier task `f25f66b1...` was locally `cancelled` after 7 polls; a cancelled local task is terminal and does not later become a local success.
- Files: `apps/desktop/src/video-polling-scheduler.ts`, `apps/worker/src/video-generation-service.ts`, `apps/desktop/src/ProductionPanel.tsx`
- Decision: local polling is functioning. The observed delay was Provider processing time plus bounded polling backoff, not a polling stall. No retry, resubmission, cancellation, or code change was performed.
- Residual risk: Windows UI capture failed with `SetIsBorderRequired failed: interface not supported`, so the visible task row could not be independently inspected. If the still-open window continues to show `polling`, that would indicate a display synchronization issue despite the persisted successful result.

