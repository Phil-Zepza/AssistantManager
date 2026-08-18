# Development Workflow

## Roles
- **Claude Code (local, in this repo):** makes the code changes, runs builds, opens PRs.
- **Phil:** reviews PRs, merges to `staging`, cuts releases to `main`.

## Git flow (MANDATORY)

> This section supersedes all previous guidance. The old "direct-to-`staging`" convention
> is retired. Feature branches + PRs are now required for every task.

### Starting a task
1. Fetch and branch off `staging`:

   ```bash
   git fetch origin staging
   git checkout -b feat/<short-slug> origin/staging
   # or fix/<short-slug> / chore/<short-slug> as appropriate
   ```

2. Make all changes on that branch. **Never commit directly to `staging` or `main`.**

### Finishing a task
1. Run `npm run build` (from `web/`) — it must pass cleanly.
2. Commit and push:

   ```bash
   git add <files>
   git commit -m "feat: ..."
   git push -u origin feat/<short-slug>
   ```

3. Open a Pull Request into `staging` on GitHub.
4. **Stop. Do not merge the PR.** Phil reviews and merges.

### Deployments
- `staging` is the only branch that deploys (after Phil merges a PR into it).
- Vercel preview deployments per branch are **disabled** — do not rely on per-branch preview URLs.
- `staging` → `main` (production release) is Phil's decision and action.

## Claude Code prompt format

Header: **Model** (Opus for architecture/gnarly debugging; Sonnet for routine tasks) ·
**Thinking** (`think` / `think hard` / `think harder` / `ultrathink`).

Then a self-contained prompt covering: context, the change required, constraints (keep existing
patterns intact), build verification (`npm run build`), and the branch/PR instruction.

## Where things live

| Path | Purpose |
|---|---|
| `docs/claude-code-tasks.md` | Append every task prompt + outcome here |
| `docs/roadmap.md` | Feature roadmap and work streams |
| `docs/project-log.md` | Setup notes and significant fixes |
| `CLAUDE.md` | Mandatory rules for Claude Code (source of truth) |
