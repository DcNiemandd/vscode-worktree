import { spawn } from "child_process";
import * as vscode from "vscode";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Single-quote a value for safe use inside a shell command line.
export function q(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function shellPath(): string {
  return process.env.SHELL || "/bin/zsh";
}

// Run a command line through a LOGIN shell so the user's PATH (brew, pnpm
// shims, herdr) is loaded — VS Code's own process PATH is often narrower.
export function sh(commandLine: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(shellPath(), ["-lc", commandLine], { cwd });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) =>
      resolve({ code: -1, stdout, stderr: stderr + String(e) }),
    );
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// Same, but stream output to an OutputChannel (for long steps like installs).
export function shStream(
  commandLine: string,
  cwd: string,
  channel: vscode.OutputChannel,
): Promise<number> {
  return new Promise((resolve) => {
    channel.appendLine(`$ ${commandLine}`);
    const p = spawn(shellPath(), ["-lc", commandLine], { cwd });
    p.stdout.on("data", (d) => channel.append(d.toString()));
    p.stderr.on("data", (d) => channel.append(d.toString()));
    p.on("error", (e) => {
      channel.appendLine(String(e));
      resolve(-1);
    });
    p.on("close", (code) => resolve(code ?? -1));
  });
}
