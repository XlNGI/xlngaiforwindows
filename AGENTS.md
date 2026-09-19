# Repository Instructions

## Asset Library Work

Before changing asset-library behavior, read and follow:

- `docs/ASSET-LIBRARY-OPTIMIZATION-PLAN.md`
- `docs/ASSET-LIBRARY-IMPLEMENTATION-PLAN.md`

Treat confirmed product decisions in the optimization plan as fixed requirements unless the user explicitly changes them.

Implement the phases in the implementation plan in order. During implementation:

- Update the implementation checklist and record the relevant verification when a phase is actually complete.
- Keep the Markdown and DOCX versions synchronized when confirmed requirements change.
- Preserve the local-first architecture: GitHub manages source code and review, not runtime material-library storage or project-data synchronization.
- Run focused tests during each phase and the repository's final quality gates before declaring the overall plan complete.

## Project Library Retrieval Work

Before changing project retrieval, context compilation, or Agent library search behavior, read and follow:

- `docs/PROJECT-LIBRARY-RETRIEVAL-IMPLEMENTATION-PLAN.md`

Treat confirmed product decisions in that plan as fixed requirements unless the user explicitly changes them. Implement the phases in order. During implementation:

- Update the implementation checklist and record verification when a phase is actually complete.
- Do not auto-inject novel chapters, memories, constraints, or document bodies into ordinary assistant sessions; those are retrieved on demand.
- Keep drafts and published documents in the same store; search results must label `draft` vs `published`.
- Do not ingest chat attachments into the retrieval index unless the user imported or saved them as drafts.
- Preserve the local-first architecture: indexes live in the current project SQLite, not in GitHub.
