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
  await sh(
    `herdr workspace create --cwd ${q(cwdPath)} --label ${q(label)} --focus`,
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
