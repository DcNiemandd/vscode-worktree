import { q, sh } from "./exec";

// herdr agent names must match /^[a-z][a-z0-9_-]{0,31}$/ AND be globally unique.
// Derive one from the branch so each worktree's agent gets a distinct, readable
// name (a constant like "claude" collides the moment a second session exists).
function herdrAgentName(label: string): string {
  const n = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-") // invalid chars → dash
    .replace(/-+/g, "-") // collapse runs
    .replace(/^[^a-z]+/, "") // must start with a lowercase letter
    .slice(0, 32)
    .replace(/[-_]+$/, ""); // no trailing separator
  return n || "claude";
}

export interface HerdrWs {
  id: string;
  label: string;
  status: string; // agent_status: "working" | "idle" | ...
}

export async function herdrAvailable(cwd: string): Promise<boolean> {
  const { code } = await sh("command -v herdr", cwd);
  return code === 0;
}

export async function listHerdr(cwd: string): Promise<HerdrWs[]> {
  const { stdout, code } = await sh("herdr workspace list", cwd);
  if (code !== 0) {
    return [];
  }
  try {
    const j = JSON.parse(stdout);
    const list = (j.result && j.result.workspaces) || [];
    return list.map((w: any) => ({
      id: w.workspace_id,
      label: w.label,
      status: w.agent_status || "?",
    }));
  } catch {
    return [];
  }
}

export async function createHerdr(
  cwdPath: string,
  label: string,
  cwd: string,
): Promise<void> {
  const { stdout } = await sh(
    `herdr workspace create --cwd ${q(cwdPath)} --label ${q(label)} --focus`,
    cwd,
  );

  // Lay the new session out as a vertical split with Claude on the left. Order
  // matters:
  //   1. WAIT for the shell prompt. The pane's login shell runs precmd hooks
  //      (e.g. nvm/fnm auto-switching on the worktree's .nvmrc) BEFORE drawing
  //      the prompt; those print output and delay readiness. `agent start` types
  //      `claude` and needs the pane already at a prompt — firing before the hook
  //      finishes races it and the keystrokes are swallowed (session comes up
  //      with a bare prompt, no Claude). Matching the prompt line guarantees the
  //      hooks are done; the timeout also acts as a settle-delay if the prompt
  //      regex ever stops matching (prompt customised), so `agent start` still
  //      lands on a quiet shell.
  //   2. START Claude in the clean, full-width root pane (before the split, so a
  //      concurrent pane redraw can't disturb prompt detection). The agent is
  //      named after the branch (unique per worktree) and launched in auto
  //      permission mode (`--permission-mode auto`).
  //   3. SPLIT a shell pane off to the right. --ratio is the LEFT pane's share,
  //      so 0.7 gives Claude 70%.
  // All best-effort — sh() never rejects, so a missing Claude/herdr just leaves
  // the workspace as-is without breaking the caller.
  let rootPane: string | undefined;
  try {
    rootPane = JSON.parse(stdout)?.result?.root_pane?.pane_id;
  } catch {
    /* non-JSON output — skip the split/agent step */
  }
  if (!rootPane) {
    return;
  }
  // Prompt line ends in a shell sigil (`%` for zsh, `$` for bash/sh).
  await sh(
    `herdr pane wait-output ${q(rootPane)} --regex ${q("[%$]\\s*$")} --timeout 15000`,
    cwd,
  );
  await sh(
    `herdr agent start ${q(herdrAgentName(label))} --kind claude --pane ${q(rootPane)} -- --permission-mode auto`,
    cwd,
  );
  await sh(
    `herdr pane split ${q(rootPane)} --direction right --ratio 0.7 --no-focus`,
    cwd,
  );
}

export async function closeHerdrByLabel(
  label: string,
  cwd: string,
): Promise<void> {
  const w = (await listHerdr(cwd)).find((x) => x.label === label);
  if (w) {
    await sh(`herdr workspace close ${q(w.id)}`, cwd);
  }
}
