import * as vscode from "vscode";
import { herdrAvailable, listHerdr } from "./herdr";
import { listWorktrees, Worktree } from "./worktrees";

export class WorktreeItem extends vscode.TreeItem {
  constructor(
    public readonly wt: Worktree,
    status: string | undefined,
    public readonly connected: boolean,
  ) {
    super(
      wt.isMain ? `★ ${wt.branch || "(main)"}` : wt.branch || wt.path,
      vscode.TreeItemCollapsibleState.None,
    );

    // contextValue drives which inline/menu actions show:
    //   worktreeMain         → open only
    //   worktreeConnected    → Disconnect (+ Remove)
    //   worktreeDisconnected → Connect (+ Remove)
    this.contextValue = wt.isMain
      ? "worktreeMain"
      : connected
        ? "worktreeConnected"
        : "worktreeDisconnected";

    if (!connected && !wt.isMain) {
      this.description = "disconnected";
      this.iconPath = new vscode.ThemeIcon(
        "circle-slash",
        new vscode.ThemeColor("disabledForeground"),
      );
    } else {
      this.description = status && status !== "none" ? status : undefined;
      this.iconPath = new vscode.ThemeIcon(
        status === "working"
          ? "circle-filled"
          : status === "idle"
            ? "circle-outline"
            : "git-branch",
      );
    }

    this.resourceUri = vscode.Uri.file(wt.path);
    this.tooltip = wt.path;
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
    const connected = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    );
    const statuses = new Map<string, string>();
    if (await herdrAvailable(root)) {
      for (const h of await listHerdr(root)) {
        statuses.set(h.label, h.status);
      }
    }
    return wts.map(
      (w) => new WorktreeItem(w, statuses.get(w.branch), connected.has(w.path)),
    );
  }
}
