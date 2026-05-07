/**
 * Spawn packaged CLI entrypoints (solveDry / solveSubmit) from the HTTP server.
 */
import * as path from "node:path";
import { spawn } from "node:child_process";

/** Cap captured CLI output per stream (characters) to avoid huge responses. */
const MAX_CLI_OUTPUT_CHARS = 2_000_000;

export type CliCommandKind = "solveDry" | "solveSubmit" | "solveDrySubmit";

export function cliInvocation(kind: CliCommandKind): { script: string; args: string[]; label: string } {
  const dry = path.join("dist", "cli", "solveDry.js");
  const submit = path.join("dist", "cli", "solveSubmit.js");
  switch (kind) {
    case "solveDry":
      return {
        script: dry,
        args: ["--includeFinished"],
        label: "npm run solve:dry (--includeFinished)",
      };
    case "solveSubmit":
      return {
        script: submit,
        args: ["--all", "--includeFinished", "--warnAfterMs=15000"],
        label: "npm run solve:submit (--all --includeFinished --warnAfterMs=15000)",
      };
    case "solveDrySubmit":
      return {
        script: dry,
        args: ["--parallel=3", "--submit", "--warnAfterMs=15000", "--includeFinished"],
        label: "npm run solve:dry:submit",
      };
  }
}

export async function runCliCommand(
  rootDir: string,
  kind: CliCommandKind,
): Promise<{
  command: CliCommandKind;
  label: string;
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}> {
  const { script, args, label } = cliInvocation(kind);
  const scriptPath = path.join(rootDir, script);
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let truncated = false;

  const append = (target: "out" | "err", chunk: Buffer) => {
    const s = chunk.toString("utf8");
    if (target === "out") {
      if (stdout.length + s.length > MAX_CLI_OUTPUT_CHARS) {
        truncated = true;
        stdout += s.slice(0, Math.max(0, MAX_CLI_OUTPUT_CHARS - stdout.length));
      } else {
        stdout += s;
      }
    } else {
      if (stderr.length + s.length > MAX_CLI_OUTPUT_CHARS) {
        truncated = true;
        stderr += s.slice(0, Math.max(0, MAX_CLI_OUTPUT_CHARS - stderr.length));
      } else {
        stderr += s;
      }
    }
  };

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (c: Buffer) => append("out", c));
    child.stderr?.on("data", (c: Buffer) => append("err", c));
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });

  return {
    command: kind,
    label,
    argv: [scriptPath, ...args],
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    truncated,
  };
}
