import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { CodexModel, ReasoningEffort } from "./contracts";

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

export interface AppServerStatus {
  authMethod: string | null;
  requiresOpenaiAuth: boolean | null;
  models: CodexModel[];
}

export function isChatGPTAuthentication(authMethod: string | null): boolean {
  return authMethod === "chatgpt";
}

export class CodexAppServer extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private buffer = "";

  public constructor(private readonly createProcess: () => ChildProcessWithoutNullStreams = () => spawn("codex", ["app-server", "--stdio"], { stdio: "pipe", shell: false })) {
    super();
  }

  async start(): Promise<AppServerStatus> {
    if (this.process) return this.status();
    this.process = this.createProcess();
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.handleData(chunk));
    this.process.stderr.on("data", (chunk: string) => this.emit("diagnostic", redact(chunk)));
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code, signal) => this.failAll(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"}).`)));

    await this.request("initialize", { clientInfo: { name: "Codex Router", version: "0.1.0" }, capabilities: null });
    return this.status();
  }

  async status(): Promise<AppServerStatus> {
    const [auth, list] = await Promise.all([
      this.request("getAuthStatus", { includeToken: false, refreshToken: false }),
      this.request("model/list", {})
    ]);
    const authResult = auth as { authMethod?: string | null; requiresOpenaiAuth?: boolean | null };
    const listResult = list as { data?: CodexModel[] };
    return { authMethod: authResult.authMethod ?? null, requiresOpenaiAuth: authResult.requiresOpenaiAuth ?? null, models: listResult.data ?? [] };
  }

  async startTurn(task: string, cwd: string, model: string, effort: ReasoningEffort): Promise<{ threadId: string; turnId: string }> {
    const threadResponse = await this.request("thread/start", { cwd, model, allowProviderModelFallback: false });
    const threadId = (threadResponse as { thread?: { id?: string } }).thread?.id;
    if (!threadId) throw new Error("Codex App Server did not return a thread ID.");
    const turnResponse = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: task }],
      model,
      effort
    });
    const turnId = (turnResponse as { turn?: { id?: string } }).turn?.id;
    if (!turnId) throw new Error("Codex App Server did not return a turn ID.");
    return { threadId, turnId };
  }

  dispose(): void {
    const child = this.process;
    this.process = undefined;
    if (child && !child.killed) child.kill();
    this.failAll(new Error("Codex App Server stopped."));
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error("Codex App Server is not running."));
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.process?.stdin.write(`${message}\n`, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try { message = JSON.parse(line) as JsonRpcMessage; } catch { this.emit("diagnostic", "Codex App Server emitted malformed JSON."); continue; }
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "Codex App Server request failed."));
        else pending.resolve(message.result);
      } else if (message.method) {
        this.emit("notification", message.method, message.params);
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.process = undefined;
  }
}

function redact(value: string): string {
  return value.replace(/(token|authorization|bearer)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}
