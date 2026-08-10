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
