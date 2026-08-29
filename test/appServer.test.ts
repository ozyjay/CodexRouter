import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { CodexAppServer, isChatGPTAuthentication } from "../src/appServer";

class FakeStream extends EventEmitter {
  public setEncoding(): this { return this; }
}

class FakeStdin extends EventEmitter {
  public constructor(private readonly onWrite: (text: string) => void) { super(); }
  public write(text: string, callback?: (error?: Error | null) => void): boolean {
    this.onWrite(text);
    callback?.(null);
    return true;
  }
}

test("App Server correlates requests and forwards stream notifications", async () => {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const requests: Array<{ id: number; method: string; params: unknown }> = [];
  const process = new EventEmitter() as EventEmitter & { stdout: FakeStream; stderr: FakeStream; stdin: FakeStdin; killed: boolean; kill: () => boolean };
  process.stdout = stdout;
  process.stderr = stderr;
  process.killed = false;
  process.kill = () => { process.killed = true; return true; };
  process.stdin = new FakeStdin((line) => {
    const request = JSON.parse(line) as { id: number; method: string; params: unknown };
    requests.push(request);
    const result = request.method === "getAuthStatus" ? { authMethod: "chatgpt", requiresOpenaiAuth: false }
      : request.method === "model/list" ? { data: [{ id: "terra", model: "gpt-5.6-terra", displayName: "Terra", description: "", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium", isDefault: true }] }
      : request.method === "thread/start" ? { thread: { id: "thread-1" } }
      : request.method === "turn/start" ? { turn: { id: "turn-1" } }
      : { userAgent: "test" };
    queueMicrotask(() => stdout.emit("data", `${JSON.stringify({ id: request.id, result })}\n`));
  });

  const server = new CodexAppServer(() => process as never);
  const notifications: Array<{ method: string; params: unknown }> = [];
  server.on("notification", (method, params) => notifications.push({ method, params }));
  const status = await server.start();
  assert.equal(status.authMethod, "chatgpt");
  assert.equal(requests.find((request) => request.method === "getAuthStatus")?.params && JSON.stringify(requests.find((request) => request.method === "getAuthStatus")?.params), JSON.stringify({ includeToken: false, refreshToken: false }));
  const turn = await server.startTurn("Fix the test", "/workspace", "gpt-5.6-terra", "medium");
  assert.deepEqual(turn, { threadId: "thread-1", turnId: "turn-1" });
  stdout.emit("data", `${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "Hello" } })}\n`);
  assert.equal(notifications[0].method, "item/agentMessage/delta");
  server.dispose();
  assert.equal(process.killed, true);
});

test("only the supported ChatGPT auth mode is accepted", () => {
  assert.equal(isChatGPTAuthentication("chatgpt"), true);
  assert.equal(isChatGPTAuthentication("apikey"), false);
  assert.equal(isChatGPTAuthentication("chatgptAuthTokens"), false);
});
