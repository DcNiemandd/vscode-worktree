import * as vscode from "vscode";

// Persists which worktrees are "connected" (added as workspace roots) so we can
// re-add them after a restart. We can't rely on VS Code remembering this: adding
// a root to a single-folder window makes an *untitled* workspace that isn't saved
// and doesn't survive a restart. So we record the connections ourselves, in
// globalState (spans all windows), keyed by the opened repo root.
const KEY = "wtHelper.connected";

// repoRoot (first workspace folder fsPath) -> connected worktree fsPaths
type Snapshot = Record<string, string[]>;

export class ConnectedStore {
  constructor(private readonly mem: vscode.Memento) {}

  private all(): Snapshot {
    return this.mem.get<Snapshot>(KEY, {});
  }

  get(root: string): string[] {
    return this.all()[root] ?? [];
  }

  async add(root: string, wtPath: string): Promise<void> {
    const snap = this.all();
    const set = new Set(snap[root] ?? []);
    set.add(wtPath);
    snap[root] = [...set];
    await this.mem.update(KEY, snap);
  }

  async remove(root: string, wtPath: string): Promise<void> {
    const snap = this.all();
    const list = snap[root];
    if (!list) {
      return;
    }
    const next = list.filter((p) => p !== wtPath);
    if (next.length) {
      snap[root] = next;
    } else {
      delete snap[root];
    }
    await this.mem.update(KEY, snap);
  }
}
