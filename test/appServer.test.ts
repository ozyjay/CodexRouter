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
    const request = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
    const id = request.id;
    const method = request.method;
    if (typeof id !== "number" || typeof method !== "string") return;
    requests.push({ id, method, params: request.params });
    const result = method === "account/read" ? { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: false }
      : method === "model/list" ? { data: [{ id: "terra", model: "gpt-5.6-terra", displayName: "Terra", description: "", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium", isDefault: true }] }
      : method === "thread/start" ? { thread: { id: "thread-1" } }
      : method === "turn/start" ? { turn: { id: "turn-1" } }
      : { userAgent: "test" };
    queueMicrotask(() => stdout.emit("data", `${JSON.stringify({ id, result })}\n`));
  });

  const server = new CodexAppServer(() => process as never);
  const notifications: Array<{ method: string; params: unknown }> = [];
  server.on("notification", (method, params) => notifications.push({ method, params }));
  const [status, concurrentStatus] = await Promise.all([server.start(), server.start()]);
  assert.equal(status.authMethod, "chatgpt");
  assert.equal(concurrentStatus.authMethod, "chatgpt");
  assert.equal(requests.filter((request) => request.method === "initialize").length, 1);
  assert.deepEqual(requests.find((request) => request.method === "account/read")?.params, { refreshToken: false });
  const turn = await server.startTurn("Fix the test", "/workspace", "gpt-5.6-terra", "medium");
  assert.deepEqual(turn, { threadId: "thread-1", turnId: "turn-1" });
  stdout.emit("data", `${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "Hello" } })}\n`);
  assert.equal(notifications[0].method, "item/agentMessage/delta");
  server.dispose();
  assert.equal(process.killed, true);
});

test("App Server forwards server requests and sends approval responses", async () => {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const writes: Array<Record<string, unknown>> = [];
  const process = new EventEmitter() as EventEmitter & { stdout: FakeStream; stderr: FakeStream; stdin: FakeStdin; killed: boolean; kill: () => boolean };
  process.stdout = stdout;
  process.stderr = stderr;
  process.killed = false;
  process.kill = () => true;
  process.stdin = new FakeStdin((line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    writes.push(message);
    if (typeof message.id !== "number" || typeof message.method !== "string") return;
    const result = message.method === "account/read" ? { account: { type: "chatgpt" }, requiresOpenaiAuth: false }
      : message.method === "model/list" ? { data: [] }
      : {};
    queueMicrotask(() => stdout.emit("data", `${JSON.stringify({ id: message.id, result })}\n`));
  });
  const server = new CodexAppServer(() => process as never);
  await server.start();
  const request = new Promise<void>((resolve) => {
    server.once("request", (id: number | string, method: string) => {
      assert.equal(id, "approval-1");
      assert.equal(method, "item/fileChange/requestApproval");
      server.respond(id, { decision: "accept" });
      resolve();
    });
  });
  stdout.emit("data", `${JSON.stringify({ id: "approval-1", method: "item/fileChange/requestApproval", params: { itemId: "item-1" } })}\n`);
  await request;
  assert.deepEqual(writes.at(-1), { id: "approval-1", result: { decision: "accept" } });
  server.dispose();
});

test("App Server supports turn interruption", async () => {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const methods: string[] = [];
  const process = new EventEmitter() as EventEmitter & { stdout: FakeStream; stderr: FakeStream; stdin: FakeStdin; killed: boolean; kill: () => boolean };
  process.stdout = stdout;
  process.stderr = stderr;
  process.killed = false;
  process.kill = () => true;
  process.stdin = new FakeStdin((line) => {
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (message.id === undefined || !message.method) return;
    methods.push(message.method);
    const result = message.method === "account/read" ? { account: { type: "chatgpt" }, requiresOpenaiAuth: false }
      : message.method === "model/list" ? { data: [] }
      : {};
    queueMicrotask(() => stdout.emit("data", `${JSON.stringify({ id: message.id, result })}\n`));
  });
  const server = new CodexAppServer(() => process as never);
  await server.start();
  await server.interruptTurn("thread-1", "turn-1");
  assert.equal(methods.at(-1), "turn/interrupt");
  server.dispose();
});

test("App Server request timeout and process exit reject pending work", async () => {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const process = new EventEmitter() as EventEmitter & { stdout: FakeStream; stderr: FakeStream; stdin: FakeStdin; killed: boolean; kill: () => boolean };
  process.stdout = stdout;
  process.stderr = stderr;
  process.killed = false;
  process.kill = () => true;
  process.stdin = new FakeStdin(() => undefined);
  const timedOut = new CodexAppServer(() => process as never, 5);
  await assert.rejects(timedOut.start(), /timed out: initialize/);

  const exitingProcess = new EventEmitter() as typeof process;
  exitingProcess.stdout = new FakeStream();
  exitingProcess.stderr = new FakeStream();
  exitingProcess.killed = false;
  exitingProcess.kill = () => true;
  exitingProcess.stdin = new FakeStdin(() => queueMicrotask(() => exitingProcess.emit("exit", 1, null)));
  const exiting = new CodexAppServer(() => exitingProcess as never, 100);
  await assert.rejects(exiting.start(), /exited/);
});

test("only the supported ChatGPT auth mode is accepted", () => {
  assert.equal(isChatGPTAuthentication("chatgpt"), true);
  assert.equal(isChatGPTAuthentication("apikey"), false);
  assert.equal(isChatGPTAuthentication("chatgptAuthTokens"), false);
});
