---
name: Imported workspace dependencies
description: Practical constraint when validating imported pnpm workspaces with inconsistent lockfiles or tracked dependency trees.
---

Imported pnpm workspaces can contain a lockfile that predates package manifests and tracked dependency-tree files that a fresh install rewrites or removes.

**Why:** A frozen install may be impossible even though the source typechecks, while an unfrozen install can create a large unrelated diff.

**How to apply:** Prefer an install mode that does not read or write the lockfile for local verification, inspect git status immediately afterward, and restore generated changes outside the requested scope.