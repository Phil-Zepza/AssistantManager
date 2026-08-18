# Development Workflow

## Roles
- **Cowork (Claude, chat):** orchestrator/architect. Writes the Claude Code prompts (with a
  recommended model + thinking level), reviews Claude Code's output, keeps these docs updated.
  Does not edit app code directly.
- **Claude Code (local, in this repo):** makes the code changes.
- **Phil:** runs Claude Code, reviews the `staging` deployment, cuts releases.

## Git flow (IMPORTANT)
- **Claude Code commits directly to `staging` and pushes** — no per-task feature branch, no PR.
  Each task ends: make the change on `staging` → commit → `git push origin staging`. Vercel
  builds the `staging` preview automatically.
- **`staging` → `main` is the release step, and it's Phil's call.** Merging `staging` into
  `main` promotes to production; Claude Code does not merge to `main` or deploy production.
- `main` stays releasable. Keep each `staging` commit self-contained and green
  (`npm run build`, `py_compile`) so `staging` is always previewable.

> This retires the older feature-branch → PR-into-`staging` flow. Direct-to-`staging` is the
> current convention; the PR gate now sits at `staging` → `main` (release), which Phil owns.

## Claude Code prompt format
Header: **Model** (Opus for architecture / gnarly debugging; Sonnet for routine) ·
**Thinking** (think / think hard / think harder / ultrathink). Then a self-contained prompt:
context, the change, constraints (keep patterns intact), verification (`npm run build`, `py_compile`),
and the commit-directly-to-`staging`-and-push instruction.

## Where things live
- **Prompts + task log:** `docs/claude-code-tasks.md` (append every task here).
- **Roadmap / streams:** `docs/roadmap.md`.
- **Project log (setup + fixes):** `docs/project-log.md`.
- **Strategy / product / architecture record:** the claude.ai Project ("FPL / LMS") docs.
