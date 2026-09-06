import { spawn } from "node:child_process";
import { DevelopmentLog as EvaluationDebugLog, debugLineSink } from "../src/developmentLog";
export { DevelopmentLog as EvaluationDebugLog, debugLineSink, redactDebugText } from "../src/developmentLog";

export async function runDebugCommand(command: string, args: string[], log: EvaluationDebugLog, phase: string, cwd?: string): Promise<{ exitCode: number; stderr: string }> {
  log.write(`${phase}.start`, { command, args });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let failure: unknown;
    const record = (event: string, detail: unknown) => {
      try { log.write(event, detail); } catch (error) { failure = error; child.kill(); }
    };
    const stdoutLines = debugLineSink((line) => record(`${phase}.stdout`, line));
    const stderrLines = debugLineSink((line) => record(`${phase}.stderr`, line));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdoutLines.push(chunk));
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4096); stderrLines.push(chunk); });
    child.on("error", (error) => { failure = error; });
    child.on("close", (code, signal) => {
      stdoutLines.finish();
      stderrLines.finish();
      record(`${phase}.finished`, { exitCode: code, signal });
      if (failure) reject(failure);
      else resolve({ exitCode: code ?? 1, stderr });
    });
  });
}
