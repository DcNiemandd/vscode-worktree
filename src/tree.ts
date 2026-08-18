import * as path from "path";
import * as vscode from "vscode";
import { herdrAvailable, listHerdr } from "./herdr";
import { listWorktrees, Worktree } from "./worktrees";

// An action in flight on a worktree row, surfaced as a spinner + description.
export type BusyState = "connecting" | "disconnecting" | "removing";

export class WorktreeItem extends vscode.TreeItem {
  constructor(
    public readonly wt: Worktree,
    status: string | undefined,
    public readonly connected: boolean,
    busy?: BusyState,
  ) {
    super(
      wt.isMain
        ? `★ ${wt.branch || "(main)"}`
        : wt.branch || path.basename(wt.path),
      vscode.TreeItemCollapsibleState.None,
    );

    // While an action is in flight, show a spinner on the row itself so it's
    // clear which worktree is busy (the view header also shows a bar).
    if (busy) {
      this.contextValue = "worktreeBusy";
      this.description = `${busy}…`;
      this.iconPath = new vscode.ThemeIcon("loading~spin");
      this.resourceUri = vscode.Uri.file(wt.path);
      this.tooltip = wt.path;
      return;
    }

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
      // The "Disconnected" group header labels these, so the row stays clean —
      // just a dimmed icon.
      this.iconPath = new vscode.ThemeIcon(
        "circle-slash",
        new vscode.ThemeColor("disabledForeground"),
      );
    } else {
      // Only surface recognized herdr statuses; a fresh session with no agent
      // reports values like "unknown"/"none" that we treat as "no status".
      const known = status === "working" || status === "idle";
      this.description = known ? status : undefined;
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

// Collapsible group header (à la Source Control's "Changes"/"Graph") that folds
// its worktrees away. The stable `id` lets VS Code remember the expand/collapse
// state across refreshes.
export type GroupKind = "connected" | "disconnected";
export class GroupItem extends vscode.TreeItem {
  constructor(
    public readonly kind: GroupKind,
    count: number,
  ) {
    super(
      kind === "connected" ? "Connected" : "Disconnected",
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.id = `group:${kind}`;
    this.contextValue = "group";
    this.description = String(count);
  }
}

type PlaceholderState = "creating" | "error";

// Synthetic URI that ties a placeholder row to its FileDecoration (which is what
// actually colours the label text — grey while creating, red on failure).
const PLACEHOLDER_SCHEME = "wt-placeholder";
function placeholderUri(branch: string): vscode.Uri {
  return vscode.Uri.from({ scheme: PLACEHOLDER_SCHEME, path: `/${branch}` });
}

// Optimistic row shown while a worktree is being created (and briefly, in red,
// if creation fails). Non-interactive: no `command`, and a contextValue that
// matches no menu `when` clause.
export class PlaceholderItem extends vscode.TreeItem {
  constructor(branch: string, state: PlaceholderState) {
    super(branch, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "placeholder";
    // resourceUri drives the FileDecoration colour; iconPath is set explicitly
    // so the synthetic URI never resolves to a file icon.
    this.resourceUri = placeholderUri(branch);
    if (state === "error") {
      this.description = "creation failed";
      this.iconPath = new vscode.ThemeIcon(
        "error",
        new vscode.ThemeColor("errorForeground"),
      );
      this.tooltip = `Creating ${branch} failed`;
    } else {
      this.description = "creating…";
      this.iconPath = new vscode.ThemeIcon(
        "loading~spin",
        new vscode.ThemeColor("disabledForeground"),
      );
      this.tooltip = `Creating ${branch}…`;
    }
  }
}

type Row = WorktreeItem | GroupItem | PlaceholderItem;

export class WorktreeProvider
  implements vscode.TreeDataProvider<Row>, vscode.FileDecorationProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private readonly _onDidChangeDeco = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeDeco.event;

  // Paths with an action in flight, so their rows can show a spinner.
  private readonly busy = new Map<string, BusyState>();

  // At most one optimistic "creating…" row at a time.
  private placeholder?: { branch: string; state: PlaceholderState };

  // Group children computed at the root level, reused when VS Code asks for a
  // group's children (so we don't re-list worktrees per group).
  private groups: { connected: WorktreeItem[]; disconnected: WorktreeItem[] } = {
    connected: [],
    disconnected: [],
  };

  constructor(private readonly repoRoot: () => string | undefined) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  setBusy(fsPath: string, state: BusyState): void {
    this.busy.set(fsPath, state);
    this.refresh();
  }

  clearBusy(fsPath: string): void {
    if (this.busy.delete(fsPath)) {
      this.refresh();
    }
  }

  private setPlaceholder(branch: string, state: PlaceholderState): void {
    this.placeholder = { branch, state };
    this.refresh();
    this._onDidChangeDeco.fire([placeholderUri(branch)]);
  }

  showCreating(branch: string): void {
    this.setPlaceholder(branch, "creating");
  }

  showCreateError(branch: string): void {
    this.setPlaceholder(branch, "error");
  }

  // Clears the optimistic row. `branch`/`state` act as guards: a delayed
  // error-clear passes both so it can't wipe a newer row (e.g. a fresh retry of
  // the same branch), while the success path clears whatever "creating" row.
  clearPlaceholder(branch?: string, state?: PlaceholderState): void {
    const p = this.placeholder;
    if (
      !p ||
      (branch !== undefined && p.branch !== branch) ||
      (state !== undefined && p.state !== state)
    ) {
      return;
    }
    this.placeholder = undefined;
    this.refresh();
    this._onDidChangeDeco.fire([placeholderUri(p.branch)]);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== PLACEHOLDER_SCHEME || !this.placeholder) {
      return undefined;
    }
    if (uri.path !== `/${this.placeholder.branch}`) {
      return undefined;
    }
    return this.placeholder.state === "error"
      ? {
          color: new vscode.ThemeColor("errorForeground"),
          tooltip: "Creation failed",
        }
      : {
          color: new vscode.ThemeColor("disabledForeground"),
          tooltip: "Creating…",
        };
  }

  getTreeItem(element: Row): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Row): Promise<Row[]> {
    // Second level: a group's worktrees (computed at the root level below).
    if (element instanceof GroupItem) {
      return element.kind === "connected"
        ? this.groups.connected
        : this.groups.disconnected;
    }
    if (element) {
      return [];
    }

    // Root level.
    const root = this.repoRoot();
    if (!root) {
      return [];
    }
    const wts = await listWorktrees(root);

    // Atomic hand-off: the moment the real worktree exists, drop the optimistic
    // "creating…" row — in this same render pass the real row is added, so there
    // is no gap, and the placeholder can never linger out of sync with reality.
    // (Error placeholders stay until their own timeout clears them.)
    if (
      this.placeholder?.state === "creating" &&
      wts.some((w) => w.branch === this.placeholder!.branch)
    ) {
      this.placeholder = undefined;
    }

    const connected = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    );
    const statuses = new Map<string, string>();
    if (await herdrAvailable(root)) {
      for (const h of await listHerdr(root)) {
        statuses.set(h.label, h.status);
      }
    }
    const items = wts.map(
      (w) =>
        new WorktreeItem(
          w,
          statuses.get(w.branch),
          connected.has(w.path),
          this.busy.get(w.path),
        ),
    );

    const byName = (a: WorktreeItem, b: WorktreeItem) =>
      (a.wt.branch || a.wt.path).localeCompare(b.wt.branch || b.wt.path);
    const main = items.find((i) => i.wt.isMain);
    this.groups = {
      connected: items.filter((i) => !i.wt.isMain && i.connected).sort(byName),
      disconnected: items
        .filter((i) => !i.wt.isMain && !i.connected)
        .sort(byName),
    };

    // Top level: optimistic row → main worktree → collapsible groups. Each group
    // appears only when it has members, so a lone empty header never shows.
    const rows: Row[] = [];
    if (this.placeholder) {
      rows.push(
        new PlaceholderItem(this.placeholder.branch, this.placeholder.state),
      );
    }
    if (main) {
      rows.push(main);
    }
    if (this.groups.connected.length) {
      rows.push(new GroupItem("connected", this.groups.connected.length));
    }
    if (this.groups.disconnected.length) {
      rows.push(new GroupItem("disconnected", this.groups.disconnected.length));
    }
    return rows;
  }
}
