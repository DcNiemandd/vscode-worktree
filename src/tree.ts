import * as vscode from "vscode";
import { herdrAvailable, listHerdr } from "./herdr";
import { listWorktrees, Worktree } from "./worktrees";

export class WorktreeItem extends vscode.TreeItem {
  constructor(
    public readonly wt: Worktree,
    status: string | undefined,
  ) {
    super(
      wt.isMain ? `★ ${wt.branch || "(main)"}` : wt.branch || wt.path,
      vscode.TreeItemCollapsibleState.None,
    );
    this.description = status && status !== "none" ? status : undefined;
    this.resourceUri = vscode.Uri.file(wt.path);
    this.tooltip = wt.path;
    // Only non-main worktrees expose the inline Remove action.
    this.contextValue = wt.isMain ? "worktreeMain" : "worktree";
    this.iconPath = new vscode.ThemeIcon(
      status === "working"
        ? "circle-filled"
        : status === "idle"
          ? "circle-outline"
          : "git-branch",
    );
    this.command = {
      command: "wtHelper.open",
      title: "Reveal in Explorer",
      arguments: [this],
    };
  }
}

export class WorktreeProvider implements vscode.TreeDataProvider<WorktreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly repoRoot: () => string | undefined) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: WorktreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<WorktreeItem[]> {
    const root = this.repoRoot();
    if (!root) {
      return [];
    }
    const wts = await listWorktrees(root);
    const statuses = new Map<string, string>();
    if (await herdrAvailable(root)) {
      for (const h of await listHerdr(root)) {
        statuses.set(h.label, h.status);
      }
    }
    return wts.map((w) => new WorktreeItem(w, statuses.get(w.branch)));
  }
}
