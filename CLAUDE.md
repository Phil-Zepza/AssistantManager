# CLAUDE.md — FPL / LMS Assistant

---

## Development workflow (MANDATORY)

> These rules apply to every task without exception. Read this section before touching any code.

### Branching
- Always create a new branch off `staging` before starting work.
- Branch names: `feat/<short-slug>` for new features, `fix/<short-slug>` for bug fixes, `chore/<short-slug>` for non-app changes.
- **Never commit directly to `staging` or `main`.**

```
git fetch origin staging
git checkout -b feat/my-change origin/staging
```

### Completing a task
1. Make all code changes on the feature branch.
2. Run `npm run build` (from `web/`) and confirm it passes with zero errors.
3. Commit and push the branch to `origin`.
4. Open a Pull Request into `staging` on GitHub.
5. **Stop there. Do NOT merge the PR.** Leave it for Phil to review and merge.

### Release
- `staging` is the only branch that receives merged PRs and deploys.
- Promoting to production (`staging` → `main`) is Phil's decision and action alone.
- **Vercel preview deployments per branch are disabled.** Do not reference or rely on per-branch preview URLs.

### Summary of who does what

| Action | Claude Code | Phil |
|---|---|---|
| Create branch off `staging` | ✅ | |
| Make code changes | ✅ | |
| `npm run build` passes | ✅ | |
| Push branch + open PR into `staging` | ✅ | |
| Review & merge PR into `staging` | | ✅ |
| Merge `staging` → `main` (release) | | ✅ |

---

## Roles

- **Claude Code (this session):** makes code changes, runs builds, opens PRs. Does not merge.
- **Phil:** reviews PRs, merges to `staging`, cuts releases to `main`.

## Repository layout

```
web/          Next.js front-end
pipeline/     Data pipeline scripts
db/           Database migrations / schema
docs/         Dev docs, roadmap, task log
```

## Build verification

From the `web/` directory:

```bash
npm run build
```

Always run this before opening a PR. A failing build blocks merge.

## Further reading

- [Development workflow detail](docs/dev-workflow.md)
- [Task log](docs/claude-code-tasks.md)
- [Roadmap](docs/roadmap.md)
