import * as path from "path";
import * as vscode from "vscode";
import { loadConfig } from "./config";
import { q, sh } from "./exec";
import {
  closeHerdrByLabel,
  createHerdr,
  herdrAvailable,
  listHerdr,
} from "./herdr";
import { WorktreeItem, WorktreeProvider } from "./tree";
import {
  createWorktree,
  gitCommonDir,
  listBranches,
  listWorktrees,
  removeWorktree,
  Worktree,
} from "./worktrees";

function firstFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// Ask the built-in Git extension to open a path as a repository. Worktrees added
// at runtime otherwise aren't picked up by Source Control until an IDE restart.
async function openGitRepo(fsPath: string): Promise<void> {
  try {
    await vscode.commands.executeCommand("git.openRepository", fsPath);
  } catch {
    /* git extension missing, or not a repo */
  }
}

async function registerRepos(): Promise<void> {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    await openGitRepo(f.uri.fsPath);
  }
}

// Close a manually-opened worktree repo from Source Control. `git.openRepository`
// marks a repo as manually opened, so VS Code won't auto-close it when the folder
// leaves — we must close it explicitly. Guarded via the Git API so we only close
// when a repo is open at EXACTLY this path (never fall through to the main repo).
async function closeGitRepo(fsPath: string): Promise<void> {
  try {
    const ext = vscode.extensions.getExtension<any>("vscode.git");
    if (!ext) {
      return;
    }
    const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    const uri = vscode.Uri.file(fsPath);
    const repo = api.getRepository(uri);
    if (repo && repo.rootUri.fsPath === fsPath) {
      await vscode.commands.executeCommand("git.close", uri);
    }
  } catch {
    /* git extension missing or repo not open */
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("wt-helper");
  const provider = new WorktreeProvider(firstFolder);

  context.subscriptions.push(
    channel,
    vscode.window.registerTreeDataProvider("wtHelperWorktrees", provider),
    vscode.commands.registerCommand("wtHelper.refresh", () =>
      provider.refresh(),
    ),
    vscode.commands.registerCommand("wtHelper.open", (item?: WorktreeItem) => {
      if (item) {
        vscode.commands.executeCommand(
          "revealInExplorer",
          vscode.Uri.file(item.wt.path),
        );
      }
    }),
    vscode.commands.registerCommand("wtHelper.new", () =>
      newWorktree(provider, channel),
    ),
    vscode.commands.registerCommand("wtHelper.connect", (item?: WorktreeItem) =>
      connectCmd(provider, item),
    ),
    vscode.commands.registerCommand(
      "wtHelper.disconnect",
      (item?: WorktreeItem) => disconnectCmd(provider, item),
    ),
    vscode.commands.registerCommand(
      "wtHelper.openHerdr",
      (item?: WorktreeItem) => openHerdrCmd(item),
    ),
    vscode.commands.registerCommand("wtHelper.openHerdrRoot", () =>
      openHerdrRootCmd(),
    ),
    vscode.commands.registerCommand("wtHelper.remove", (item?: WorktreeItem) =>
      removeWorktreeCmd(provider, channel, item),
    ),
    // Keep the tree in sync when worktrees are connected/disconnected (or added
    // by anything else) — without this the list is stale until a manual refresh.
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
  );

  // Nudge the built-in Git extension to register every worktree root as a
  // repository, so Source Control reacts without needing an IDE restart.
  void registerRepos();
}

export function deactivate(): void {
  /* nothing to clean up */
}

// QuickPick that lets you select an existing branch OR type a new name.
function pickBranch(root: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.placeholder =
      "Pick an existing branch, or type a new name and press Enter";
    qp.busy = true;
    qp.show();

    listBranches(root).then((branches) => {
      qp.items = branches.map((b) => ({ label: b }));
      qp.busy = false;
    });

    qp.onDidAccept(() => {
      const chosen = qp.selectedItems[0]?.label || qp.value.trim();
      qp.hide();
      resolve(chosen || undefined);
    });
    qp.onDidHide(() => {
      qp.dispose();
      resolve(undefined);
    });
  });
}

async function newWorktree(
  provider: WorktreeProvider,
  channel: vscode.OutputChannel,
): Promise<void> {
  const root = firstFolder();
  if (!root) {
    vscode.window.showErrorMessage("wt-helper: open a folder first.");
    return;
  }

  const branch = await pickBranch(root);
  if (!branch) {
    return;
  }

  const cfg = loadConfig(root);
  if (!cfg.createCmd && !cfg.baseDir) {
    cfg.baseDir = path.join(await gitCommonDir(root), ".worktrees");
  }

  channel.clear();
  let newPath: string | undefined;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Creating worktree for ${branch}…`,
    },
    async () => {
      try {
        newPath = await createWorktree(branch, cfg, root, channel);
      } catch (e: any) {
        channel.show();
        vscode.window.showErrorMessage(`wt-helper: ${e.message}`);
      }
    },
  );
  if (!newPath) {
    return;
  }

  provider.refresh();
  vscode.window.showInformationMessage(
    `wt-helper: worktree ready for ${branch}`,
  );

  // Connect it: herdr session + workspace root. (doConnect adds the root last,
  // because the single → multi-root transition can restart the extension host.)
  await doConnect({ path: newPath, branch, isMain: false }, root);
}

// Attach an existing worktree to VS Code (+ herdr) without creating anything.
async function doConnect(wt: Worktree, root: string): Promise<void> {
  const cfg = loadConfig(root);
  if (cfg.herdr && wt.branch && (await herdrAvailable(root))) {
    const exists = (await listHerdr(root)).some((h) => h.label === wt.branch);
    if (!exists) {
      try {
        await createHerdr(wt.path, wt.branch, root);
      } catch {
        /* best-effort */
      }
    }
  }
  // Register with Source Control before the (possibly host-restarting) add.
  await openGitRepo(wt.path);

  // Add the workspace root LAST (may restart the extension host).
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.some((f) => f.uri.fsPath === wt.path)) {
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
      uri: vscode.Uri.file(wt.path),
      name: wt.branch || undefined,
    });
  }
}

// Detach a worktree from VS Code (+ herdr). Does NOT delete it from disk.
async function doDisconnect(wt: Worktree, root: string): Promise<void> {
  const cfg = loadConfig(root);
  if (cfg.herdr && wt.branch && (await herdrAvailable(root))) {
    try {
      await closeHerdrByLabel(wt.branch, root);
    } catch {
      /* best-effort */
    }
  }
  // Close the Source Control repo (it was manually opened, so it won't auto-close).
  await closeGitRepo(wt.path);

  const folders = vscode.workspace.workspaceFolders ?? [];
  const idx = folders.findIndex((f) => f.uri.fsPath === wt.path);
  if (idx >= 0) {
    vscode.workspace.updateWorkspaceFolders(idx, 1);
  }
}

async function connectCmd(
  provider: WorktreeProvider,
  item?: WorktreeItem,
): Promise<void> {
  const root = firstFolder();
  if (!root) {
    return;
  }
  let wt: Worktree | undefined = item?.wt;
  if (!wt) {
    const connected = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    );
    const candidates = (await listWorktrees(root)).filter(
      (w) => !w.isMain && !connected.has(w.path),
    );
    if (!candidates.length) {
      vscode.window.showInformationMessage(
        "wt-helper: all worktrees are already connected.",
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map((w) => ({
        label: w.branch || w.path,
        description: w.path,
        wt: w,
      })),
      { placeHolder: "Connect which worktree?" },
    );
    wt = pick?.wt;
  }
  if (!wt || wt.isMain) {
    return;
  }
  await doConnect(wt, root);
  provider.refresh();
  vscode.window.showInformationMessage(
    `wt-helper: connected ${wt.branch || wt.path}`,
  );
}

async function disconnectCmd(
  provider: WorktreeProvider,
  item?: WorktreeItem,
): Promise<void> {
  const root = firstFolder();
  if (!root) {
    return;
  }
  let wt: Worktree | undefined = item?.wt;
  if (!wt) {
    const connected = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    );
    const candidates = (await listWorktrees(root)).filter(
      (w) => !w.isMain && connected.has(w.path),
    );
    if (!candidates.length) {
      vscode.window.showInformationMessage(
        "wt-helper: no connected worktrees to disconnect.",
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map((w) => ({
        label: w.branch || w.path,
        description: w.path,
        wt: w,
      })),
      { placeHolder: "Disconnect which worktree? (keeps it on disk)" },
    );
    wt = pick?.wt;
  }
  if (!wt || wt.isMain) {
    return;
  }
  await doDisconnect(wt, root);
  provider.refresh();
  vscode.window.showInformationMessage(
    `wt-helper: disconnected ${wt.branch || wt.path} (worktree kept)`,
  );
}

// Open (or focus) a worktree's herdr session in a new terminal pane.
async function openHerdrForWorktree(wt: Worktree, root: string): Promise<void> {
  if (!(await herdrAvailable(root))) {
    vscode.window.showErrorMessage(
      "wt-helper: herdr is not installed / not on PATH.",
    );
    return;
  }

  const label = wt.branch || path.basename(wt.path);

  // Ensure a session exists for this worktree, then focus it server-side so the
  // attaching client opens on it.
  const existing = (await listHerdr(root)).find((s) => s.label === label);
  if (existing) {
    await sh(`herdr workspace focus ${q(existing.id)}`, root);
  } else {
    try {
      await createHerdr(wt.path, label, root);
    } catch {
      /* best-effort */
    }
  }

  // Open a dedicated terminal pane (editor area) and attach to herdr.
  const term = vscode.window.createTerminal({
    name: `herdr: ${label}`,
    cwd: wt.path,
    location: vscode.TerminalLocation.Editor,
  });
  term.show();
  term.sendText("herdr");
}

// Row / palette entry: target a chosen worktree.
async function openHerdrCmd(item?: WorktreeItem): Promise<void> {
  const root = firstFolder();
  if (!root) {
    return;
  }
  let wt: Worktree | undefined = item?.wt;
  if (!wt) {
    const all = await listWorktrees(root);
    const pick = await vscode.window.showQuickPick(
      all.map((w) => ({
        label: w.branch || w.path,
        description: w.path,
        wt: w,
      })),
      { placeHolder: "Open herdr for which worktree?" },
    );
    wt = pick?.wt;
  }
  if (!wt) {
    return;
  }
  await openHerdrForWorktree(wt, root);
}

// Title-bar entry: same action as the root (main) worktree's herdr button.
async function openHerdrRootCmd(): Promise<void> {
  const root = firstFolder();
  if (!root) {
    return;
  }
  const main = (await listWorktrees(root)).find((w) => w.isMain) ?? {
    path: root,
    branch: "",
    isMain: true,
  };
  await openHerdrForWorktree(main, root);
}

async function removeWorktreeCmd(
  provider: WorktreeProvider,
  channel: vscode.OutputChannel,
  item?: WorktreeItem,
): Promise<void> {
  const root = firstFolder();
  if (!root) {
    return;
  }

  let wt: Worktree | undefined = item?.wt;
  if (!wt) {
    const removable = (await listWorktrees(root)).filter((w) => !w.isMain);
    if (!removable.length) {
      vscode.window.showInformationMessage(
        "wt-helper: no removable worktrees.",
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      removable.map((w) => ({
        label: w.branch || w.path,
        description: w.path,
        wt: w,
      })),
      { placeHolder: "Remove which worktree?" },
    );
    wt = pick?.wt;
  }
  if (!wt || wt.isMain) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove worktree '${wt.branch || wt.path}'? This deletes its working copy.`,
    { modal: true },
    "Remove",
  );
  if (confirm !== "Remove") {
    return;
  }

  const cfg = loadConfig(root);
  const target = wt;

  // Delete first; only detach (herdr + workspace root) once the delete succeeds,
  // so a failed/cancelled removal leaves the worktree connected and untouched.
  const finish = async (forced: boolean) => {
    await doDisconnect(target, root);
    provider.refresh();
    vscode.window.showInformationMessage(
      `wt-helper: ${forced ? "force-removed" : "removed"} ${target.branch || target.path}`,
    );
  };

  channel.clear();
  try {
    await removeWorktree(target, cfg, root, channel);
    await finish(false);
  } catch (e: any) {
    channel.show();
    const choice = await vscode.window.showErrorMessage(
      `wt-helper: ${e.message}`,
      "Force remove",
    );
    if (choice === "Force remove") {
      try {
        await removeWorktree(target, cfg, root, channel, true);
        await finish(true);
      } catch (e2: any) {
        vscode.window.showErrorMessage(`wt-helper: ${e2.message}`);
      }
    }
  }
}
