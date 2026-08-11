# wt-helper — Git Worktrees + herdr (VS Code)

A local, private VS Code extension: a **Worktrees** sidebar to create, open, and
remove git worktrees, add/remove them as workspace roots natively, and
(optionally) tie each to a [herdr](https://herdr.dev) agent session — all without
touching the terminal.

## Features

- **Worktrees sidebar** — one row per worktree, branch name + herdr status icon
  (working / idle / none). Title-bar **New** / **Refresh**, per-row **Remove**.
- **New Worktree** — quick-pick an existing branch (recency-sorted) _or_ type a
  new name to create one. Creates the worktree, adds it as a workspace root, and
  opens a herdr session if enabled.
- **Remove Worktree** — drops the workspace root (native, no reload), closes the
  herdr session, and removes the worktree; offers `--force` on failure.

## Configuration

Reads a repo-root **`.wt-helper.conf`** first, then VS Code settings, then
built-in defaults. Keys:

| `.wt-helper.conf` | VS Code setting          | Default                       |
| ----------------- | ------------------------ | ----------------------------- |
| `WT_CREATE_CMD`   | `wtHelper.createCommand` | `git worktree add`            |
| `WT_REMOVE_CMD`   | `wtHelper.removeCommand` | `git worktree remove`         |
| `WT_HERDR`        | `wtHelper.herdr`         | off                           |
| `WT_BASE_DIR`     | `wtHelper.baseDir`       | `<git-common-dir>/.worktrees` |

`WT_CREATE_CMD` receives the branch name as its final argument; `WT_REMOVE_CMD`
receives the worktree path.

## Build & install

```bash
npm install
npm run compile      # esbuild → dist/extension.js
npm run package      # vsce → wt-helper.vsix
code --install-extension wt-helper.vsix
```

All commands run through a login shell so `git`, `pnpm`, and `herdr` resolve
from your normal PATH.
