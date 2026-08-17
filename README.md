# vscode-worktree-herdr

Manage git worktrees and their [herdr](https://herdr.dev) agent sessions from a
VS Code sidebar — no terminal needed.

> **herdr is optional and off by default.** At its core this is a plain **git
> worktree manager**: create, open, and remove worktrees and add them as native
> workspace roots, entirely without a herdr session in sight. Turn herdr on only
> if you want each worktree paired with an agent session — see
> [herdr integration](#herdr-integration-optional).

## What it does

- **Worktrees sidebar** — one row per git worktree, showing its branch name.
  Title-bar **New** and **Refresh**; per-row **Remove**, **Connect** /
  **Disconnect**, and **Reveal in Explorer**.
- **New Worktree** — quick-pick an existing branch (recency-sorted) _or_ type a
  new name to create one. Creates the worktree and adds it as a workspace root.
- **Connect / Disconnect** — add or drop a worktree as a native VS Code
  workspace root, with no window reload.
- **Remove Worktree** — drops the workspace root and removes the worktree;
  offers `--force` if git refuses (e.g. dirty tree).

Everything above works standalone. The extension never needs herdr, and never
starts a herdr session unless you explicitly enable it.

## herdr integration (optional)

When `wtHelper.herdr` (or `WT_HERDR=on`) is enabled, the extension additionally
ties each worktree to a [herdr](https://herdr.dev) agent session:

- **Status icon** per row — working / idle / none.
- **New Worktree** also opens a herdr session for the new worktree, launching
  Claude (auto permission mode) in a vertical split, with the agent named after
  the branch.
- **Remove Worktree** also closes the matching herdr session.
- **Open herdr Session** — open a session for a worktree (or the repo root) on
  demand from the row/title menus.

If the `herdr` CLI isn't on your `PATH`, these steps are silently skipped — the
worktree operations still succeed.

## Configuration

Settings are read from a repo-root **`.wt-helper.conf`** first, then VS Code
settings, then built-in defaults:

| `.wt-helper.conf` | VS Code setting          | Default                       | Purpose                                                         |
| ----------------- | ------------------------ | ----------------------------- | -------------------------------------------------------------- |
| `WT_CREATE_CMD`   | `wtHelper.createCommand` | `git worktree add`            | Command to create a worktree; receives the branch as last arg. |
| `WT_REMOVE_CMD`   | `wtHelper.removeCommand` | `git worktree remove`         | Command to remove a worktree; receives the path as last arg.   |
| `WT_HERDR`        | `wtHelper.herdr`         | `off`                         | Pair each worktree with a herdr session.                       |
| `WT_BASE_DIR`     | `wtHelper.baseDir`       | `<repo-root>/.worktrees`      | Where built-in `git worktree add` places new worktrees.        |

In `.wt-helper.conf`, `WT_HERDR` takes `on` / `off`; values may be quoted.

## Build & install

```bash
npm install
npm run compile      # esbuild → dist/extension.js
npm run package      # vsce → wt-helper.vsix
code --install-extension wt-helper.vsix
```

All commands run through a login shell, so `git`, `pnpm`, and `herdr` resolve
from your normal `PATH`.

## License

MIT
