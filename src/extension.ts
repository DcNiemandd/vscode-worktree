import * as path from "path";
import * as vscode from "vscode";
import { loadConfig } from "./config";
import { closeHerdrByLabel, createHerdr, herdrAvailable } from "./herdr";
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
    vscode.commands.registerCommand("wtHelper.remove", (item?: WorktreeItem) =>
      removeWorktreeCmd(provider, channel, item),
    ),
  );
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

  // herdr BEFORE touching workspace folders — adding a root can restart the
  // extension host (single → multi-root), which would abort anything after it.
  if (cfg.herdr && (await herdrAvailable(root))) {
    try {
      await createHerdr(newPath, branch, root);
    } catch {
      /* best-effort */
    }
  }

  provider.refresh();
  vscode.window.showInformationMessage(
    `wt-helper: worktree ready for ${branch}`,
  );

  // Add as a workspace root LAST.
  const folders = vscode.workspace.workspaceFolders ?? [];
  vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
    uri: vscode.Uri.file(newPath),
    name: branch,
  });
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

  // 1) drop the workspace-folder root (native, instant, no reload)
  const folders = vscode.workspace.workspaceFolders ?? [];
  const idx = folders.findIndex((f) => f.uri.fsPath === wt!.path);
  if (idx >= 0) {
    vscode.workspace.updateWorkspaceFolders(idx, 1);
  }

  // 2) close the matching herdr session
  if (cfg.herdr && wt.branch && (await herdrAvailable(root))) {
    try {
      await closeHerdrByLabel(wt.branch, root);
    } catch {
      /* best-effort */
    }
  }

  // 3) remove the worktree itself, offering --force on failure
  channel.clear();
  try {
    await removeWorktree(wt, cfg, root, channel);
    provider.refresh();
    vscode.window.showInformationMessage(
      `wt-helper: removed ${wt.branch || wt.path}`,
    );
  } catch (e: any) {
    channel.show();
    const choice = await vscode.window.showErrorMessage(
      `wt-helper: ${e.message}`,
      "Force remove",
    );
    if (choice === "Force remove") {
      try {
        await removeWorktree(wt, cfg, root, channel, true);
        provider.refresh();
        vscode.window.showInformationMessage(
          `wt-helper: force-removed ${wt.branch || wt.path}`,
        );
      } catch (e2: any) {
        vscode.window.showErrorMessage(`wt-helper: ${e2.message}`);
      }
    }
  }
}
