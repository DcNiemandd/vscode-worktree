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
  let cmdLine: string;
  if (cfg.removeCmd && !force) {
    cmdLine = `${cfg.removeCmd} ${q(wt.path)}`;
  } else {
    cmdLine = `git worktree remove ${force ? "--force " : ""}${q(wt.path)}`;
  }
  const code = await shStream(cmdLine, cwd, channel);
  if (code !== 0) {
    throw new Error(`worktree removal failed (exit ${code})`);
  }
}
