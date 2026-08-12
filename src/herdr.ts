import { q, sh } from "./exec";

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

  // Lay the new session out as a vertical split with Claude on the left: parse
  // the root pane id, split a fresh pane off to the RIGHT (the root pane stays
  // on the left), then start Claude in that left pane at its shell prompt. All
  // best-effort — sh() never rejects, so a missing Claude/herdr just leaves the
  // workspace (and split) as-is without breaking the caller.
  let rootPane: string | undefined;
  try {
    rootPane = JSON.parse(stdout)?.result?.root_pane?.pane_id;
  } catch {
    /* non-JSON output — skip the split/agent step */
  }
  if (!rootPane) {
    return;
  }
  await sh(`herdr pane split ${q(rootPane)} --direction right --no-focus`, cwd);
  await sh(`herdr agent start claude --kind claude --pane ${q(rootPane)}`, cwd);
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
