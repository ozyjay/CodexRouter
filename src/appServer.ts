import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { CodexModel, ReasoningEffort } from "./contracts";

interface JsonRpcMessage {
  id?: number | string;
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
  private readonly pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private buffer = "";
  private startPromise?: Promise<AppServerStatus>;

  public constructor(
    private readonly createProcess: () => ChildProcessWithoutNullStreams = () => spawn("codex", ["app-server", "--stdio"], { stdio: "pipe", shell: false }),
    private readonly requestTimeoutMs = 30_000
  ) {
    super();
  }

  async start(): Promise<AppServerStatus> {
    if (this.startPromise) return this.startPromise;
    if (this.process) return this.status();
    const startPromise = this.startProcess();
    this.startPromise = startPromise;
    try { return await startPromise; }
    finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  private async startProcess(): Promise<AppServerStatus> {
    this.process = this.createProcess();
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.handleData(chunk));
    this.process.stderr.on("data", () => this.emit("diagnostic", "Codex App Server wrote diagnostic output; details were withheld for privacy."));
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code, signal) => this.failAll(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"}).`)));

    try {
      await this.request("initialize", { clientInfo: { name: "Codex Router", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      this.notify("initialized");
      return await this.status();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  async status(): Promise<AppServerStatus> {
    const [auth, list] = await Promise.all([
      this.request("account/read", { refreshToken: false }),
      this.request("model/list", {})
    ]);
    const authResult = auth as { account?: { type?: string } | null; requiresOpenaiAuth?: boolean | null };
    const listResult = list as { data?: unknown };
    if (!Array.isArray(listResult.data) || !listResult.data.every(isCodexModel)) throw new Error("Codex App Server returned an invalid model catalogue.");
    return { authMethod: authResult.account?.type ?? null, requiresOpenaiAuth: authResult.requiresOpenaiAuth ?? null, models: listResult.data };
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

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  respond(id: number | string, result?: unknown, error?: { code: number; message: string }): void {
    if (!this.process) throw new Error("Codex App Server is not running.");
    const message = error ? { id, error } : { id, result };
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
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
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.process?.stdin.write(`${message}\n`, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (!this.process) throw new Error("Codex App Server is not running.");
    const message = params === undefined ? { method } : { method, params };
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try { message = JSON.parse(line) as JsonRpcMessage; } catch { this.emit("diagnostic", "Codex App Server emitted malformed JSON."); continue; }
      if (message.id !== undefined && message.method) {
        this.emit("request", message.id, message.method, message.params);
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`Codex App Server request failed: ${pending.method}.`));
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
    this.emit("stopped", error);
  }
}

function isCodexModel(value: unknown): value is CodexModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Partial<CodexModel>;
  return typeof model.id === "string"
    && typeof model.model === "string"
    && typeof model.displayName === "string"
    && typeof model.hidden === "boolean"
    && typeof model.isDefault === "boolean"
    && typeof model.defaultReasoningEffort === "string"
    && Array.isArray(model.supportedReasoningEfforts)
    && model.supportedReasoningEfforts.length > 0
    && model.supportedReasoningEfforts.every((effort) => Boolean(effort) && typeof effort.reasoningEffort === "string")
    && model.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === model.defaultReasoningEffort);
}
