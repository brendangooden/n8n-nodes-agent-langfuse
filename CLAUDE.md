# Project Instructions

## Releasing a new version

Releases are tag-triggered via `.github/workflows/release.yml` (npm publish + GitHub release). Pushing to `main` does NOT release.

1. Bump version: `npm version <patch|minor|major> --no-git-tag-version` (updates `package.json` AND `package-lock.json` — commit both)
2. Commit and push to `main`
3. Tag and push: `git tag v<version> && git push origin v<version>`

The workflow fails if the tag doesn't match `package.json` version.

## Upstream PRs

- `origin` = brendangooden fork, `upstream` = Diward/n8n-nodes-agent-langfuse
- PR branches (e.g. `feat/prompt-variables`) target upstream — keep fork-only commits (scope rename to `@brendangubt`, version bumps, CI workflows) OFF these branches; cherry-pick feature commits only
