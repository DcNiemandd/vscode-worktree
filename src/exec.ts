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

// Internal queries (`sh`) must never block, and shouldn't ever prompt, so they
// run with stdin closed (equivalent to `< /dev/null`) — an interactive `read`
// would get EOF and fall through to its default. User-facing scripts (`shStream`)
// instead keep a writable stdin so we can forward answers (see below).
const NO_STDIN: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

// Heuristic: does this unterminated line look like it's waiting for an answer?
// Matches trailing prompt punctuation ("? ", ":", "]", ")") or a y/n token.
function looksLikePrompt(text: string): boolean {
  return /[?:\])]\s*$/.test(text) || /\((?:y\/n|yes\/no)\)\s*$/i.test(text);
}

// A yes/no prompt like "[y/N]" / "[Y/n]" / "(y/n)"? Returns whether it's one and
// which side is the default (the capitalised letter; y/n with no caps → No).
function yesNoPrompt(text: string): { isYesNo: boolean; defaultYes: boolean } {
  const m = /\[(y\/n)\]|\((y\/n|yes\/no)\)/i.exec(text);
  return { isYesNo: !!m, defaultYes: /\[Y\/n\]/.test(text) };
}

// Ask the user to answer a detected prompt, returning the text to send to stdin.
async function askPrompt(prompt: string): Promise<string> {
  const { isYesNo, defaultYes } = yesNoPrompt(prompt);
  if (isYesNo) {
    // A QuickPick dropdown (like the branch picker), not a centred modal.
    const pick = await vscode.window.showQuickPick(["Yes", "No"], {
      placeHolder: prompt,
      ignoreFocusOut: true,
    });
    if (pick === "Yes") {
      return "y";
    }
    if (pick === "No") {
      return "n";
    }
    // Dismissed → take the prompt's own default so we never re-hang.
    return defaultYes ? "y" : "n";
  }
  const input = await vscode.window.showInputBox({
    prompt,
    ignoreFocusOut: true,
  });
  return input ?? "";
}

// Run a command line through a LOGIN shell so the user's PATH (brew, pnpm
// shims, herdr) is loaded — VS Code's own process PATH is often narrower.
export function sh(commandLine: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(shellPath(), ["-lc", commandLine], { cwd, stdio: NO_STDIN });
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
// Keeps a writable stdin: when the script goes idle on a prompt-looking line, we
// surface it as a VS Code dialog and pipe the answer back. This is a best-effort
// bridge for `read`-style prompts, not a real PTY.
const PROMPT_IDLE_MS = 500;

export function shStream(
  commandLine: string,
  cwd: string,
  channel: vscode.OutputChannel,
): Promise<number> {
  return new Promise((resolve) => {
    channel.appendLine(`$ ${commandLine}`);
    const p = spawn(shellPath(), ["-lc", commandLine], { cwd });

    // A rolling tail of recent output. When the script goes quiet mid-run, its
    // last non-empty line is the prompt it's waiting on — whether that line was
    // newline-terminated (`echo` + bare `read`) or left dangling (`read -p`).
    let recent = "";
    let idle: ReturnType<typeof setTimeout> | undefined;
    let prompting = false;
    let lastAsked = "";

    const lastLine = (): string => {
      const lines = recent
        .split(/\r\n|\r|\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      return lines[lines.length - 1] ?? "";
    };

    const maybePrompt = async () => {
      if (prompting || p.exitCode !== null || !p.stdin?.writable) {
        return;
      }
      const text = lastLine();
      // Gate on prompt-looking text so silent pauses (installs, fetches) don't
      // trigger a dialog; `lastAsked` stops us re-asking the same line.
      if (!text || text === lastAsked || !looksLikePrompt(text)) {
        return;
      }
      prompting = true;
      lastAsked = text;
      const answer = await askPrompt(text);
      if (p.stdin.writable) {
        p.stdin.write(answer + "\n");
        channel.append(answer + "\n");
      }
      prompting = false;
    };

    const onData = (d: Buffer) => {
      const s = d.toString();
      channel.append(s);
      recent = (recent + s).slice(-2048);
      if (idle) {
        clearTimeout(idle);
      }
      idle = setTimeout(() => void maybePrompt(), PROMPT_IDLE_MS);
    };

    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("error", (e) => {
      if (idle) {
        clearTimeout(idle);
      }
      channel.appendLine(String(e));
      resolve(-1);
    });
    p.on("close", (code) => {
      if (idle) {
        clearTimeout(idle);
      }
      resolve(code ?? -1);
    });
  });
}
