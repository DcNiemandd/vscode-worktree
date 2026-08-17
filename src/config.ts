import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface WtConfig {
  createCmd: string; // takes branch as final arg; "" => built-in git worktree add
  removeCmd: string; // takes path as final arg;   "" => built-in git worktree remove
  herdr: boolean;
  baseDir: string; // "" => <repo-root>/.worktrees
}

// Precedence: .wt-helper.conf (repo root) > VS Code settings > built-in defaults.
export function loadConfig(repoRoot: string): WtConfig {
  const conf: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(path.join(repoRoot, ".wt-helper.conf"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      conf[m[1]] = v;
    }
  } catch {
    /* no conf file — fall back to settings/defaults */
  }

  const s = vscode.workspace.getConfiguration("wtHelper");
  return {
    createCmd: conf.WT_CREATE_CMD ?? s.get<string>("createCommand", ""),
    removeCmd: conf.WT_REMOVE_CMD ?? s.get<string>("removeCommand", ""),
    herdr:
      conf.WT_HERDR !== undefined
        ? conf.WT_HERDR === "on"
        : s.get<boolean>("herdr", false),
    baseDir: conf.WT_BASE_DIR ?? s.get<string>("baseDir", ""),
  };
}
