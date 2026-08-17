# Development Workflow

## Roles
- **Cowork (Claude, chat):** orchestrator/architect. Writes the Claude Code prompts (with a
  recommended model + thinking level), reviews Claude Code's output before merge, keeps these docs
  updated. Does not edit app code directly.
- **Claude Code (local, in this repo):** makes the code changes.
- **Phil:** runs Claude Code, reviews PRs, merges.

## Git / PR flow (IMPORTANT)
- Branches: feature branches → PR into **`staging`**; merge **`staging` → `main`** to release.
- Claude Code must **NOT** commit directly to `staging`/`main` and must **NOT** merge.
- Every task ends: branch off `staging` (`fix/…` or `feat/…`) → commit → push → open PR into
  `staging` (`gh pr create`, or push + print the compare URL). Phil reviews (Vercel builds a
  per-branch preview) and merges.

## Claude Code prompt format
Header: **Model** (Opus for architecture / gnarly debugging; Sonnet for routine) ·
**Thinking** (think / think hard / think harder / ultrathink). Then a self-contained prompt:
context, the change, constraints (keep patterns intact), verification (`npm run build`, `py_compile`),
and the branch+PR instruction.

## Where things live
- **Prompts + task log:** `docs/claude-code-tasks.md` (append every task here).
- **Roadmap / streams:** `docs/roadmap.md`.
- **Project log (setup + fixes):** `docs/project-log.md`.
- **Strategy / product / architecture record:** the claude.ai Project ("FPL / LMS") docs.
