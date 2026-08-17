import * as path from "path";
import * as vscode from "vscode";
import { WtConfig } from "./config";
import { q, sh, shStream } from "./exec";

export interface Worktree {
  path: string;
  branch: string; // short name, or "(detached)"
  isMain: boolean;
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const { stdout } = await sh("git worktree list --porcelain", cwd);
  const wts: Worktree[] = [];
  let cur: { path?: string; branch?: string } = {};
  const flush = () => {
    if (cur.path) {
      wts.push({ path: cur.path, branch: cur.branch ?? "", isMain: false });
    }
    cur = {};
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      flush();
      cur.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "detached") {
      cur.branch = "(detached)";
    }
  }
  flush();
  if (wts.length) {
    wts[0].isMain = true;
  }
  return wts;
}

// Local + remote branches, most-recently-committed first, origin/ stripped, deduped.
export async function listBranches(cwd: string): Promise<string[]> {
  const { stdout } = await sh(
    "git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads refs/remotes/origin",
    cwd,
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (let b of stdout.split(/\r?\n/)) {
    b = b.replace(/^origin\//, "").trim();
    if (!b || b === "HEAD" || b === "origin" || seen.has(b)) {
      continue;
    }
    seen.add(b);
    out.push(b);
  }
  return out;
}

export async function gitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await sh(
    'cd "$(git rev-parse --show-toplevel)" && cd "$(git rev-parse --git-common-dir)" && pwd',
    cwd,
  );
  return stdout.trim();
}

// Primary checkout root — where worktrees should live (`<root>/.worktrees`).
// `gitCommonDir` returns `<repo>/.git` on a normal clone, so strip the trailing
// `.git`; on a true bare repo the common dir is already the root.
export async function primaryRepoRoot(cwd: string): Promise<string> {
  const common = await gitCommonDir(cwd);
  return path.basename(common) === ".git" ? path.dirname(common) : common;
}

// Create (or attach) a worktree for `branch`. Returns the new worktree path.
export async function createWorktree(
  branch: string,
  cfg: WtConfig,
  cwd: string,
  channel: vscode.OutputChannel,
): Promise<string | undefined> {
  const before = new Set((await listWorktrees(cwd)).map((w) => w.path));

  let cmdLine: string;
  if (cfg.createCmd) {
    cmdLine = `${cfg.createCmd} ${q(branch)}`;
  } else {
    const slug = branch.replace(/\//g, "-");
    const target = path.join(cfg.baseDir, slug);
    cmdLine =
      `if git show-ref --verify --quiet ${q("refs/heads/" + branch)}; then ` +
      `git worktree add ${q(target)} ${q(branch)}; ` +
      `elif git show-ref --verify --quiet ${q("refs/remotes/origin/" + branch)}; then ` +
      `git worktree add ${q(target)} ${q(branch)}; ` +
      `else git worktree add -b ${q(branch)} ${q(target)}; fi`;
  }

  const code = await shStream(cmdLine, cwd, channel);
  if (code !== 0) {
    throw new Error(
      `worktree creation failed (exit ${code}) — see the wt-helper output`,
    );
  }

  const after = await listWorktrees(cwd);
  const added = after.find((w) => !before.has(w.path));
  return (added ?? after.find((w) => w.branch === branch))?.path;
}

export async function removeWorktree(
  wt: Worktree,
  cfg: WtConfig,
  cwd: string,
  channel: vscode.OutputChannel,
  force = false,
): Promise<void> {
  // A configured custom remove command (e.g. the repo's cleanup script) owns the
  // removal — unless we're force-removing, which always uses the robust git path.
  if (cfg.removeCmd && !force) {
    const code = await shStream(`${cfg.removeCmd} ${q(wt.path)}`, cwd, channel);
    if (code !== 0) {
      throw new Error(`worktree removal failed (exit ${code})`);
    }
    return;
  }

  // Guard against an `rm -rf` on anything that isn't a genuine worktree path.
  if (!wt.path || !path.isAbsolute(wt.path) || wt.path === cwd || wt.isMain) {
    throw new Error(`refusing to remove unsafe worktree path: ${wt.path}`);
  }

  // Worktrees here always carry untracked build artifacts (node_modules, .next,
  // .turbo), so a plain `git worktree remove` refuses with "contains modified or
  // untracked files", and even `--force` can exit non-zero when a background
  // process (e.g. the turbo daemon) rewrites a cache file mid-delete — git still
  // unregisters the worktree but leaves a stub directory behind. So: force-remove,
  // then unconditionally clear any leftover directory and prune the admin entry.
  // Success is verified by the worktree leaving `git worktree list`, NOT by git's
  // exit code (which lies when only the final rmdir failed).
  await shStream(`git worktree remove --force ${q(wt.path)}`, cwd, channel);
  await shStream(`rm -rf ${q(wt.path)}`, cwd, channel);
  await shStream("git worktree prune", cwd, channel);

  const stillRegistered = (await listWorktrees(cwd)).some(
    (w) => w.path === wt.path,
  );
  if (stillRegistered) {
    throw new Error(`worktree still registered after removal: ${wt.path}`);
  }
}
