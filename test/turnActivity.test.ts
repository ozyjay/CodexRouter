import assert from "node:assert/strict";
import test from "node:test";
import { TurnActivity, TurnActivityTracker } from "../src/turnActivity";

function setup() {
  const updates: TurnActivity[] = [];
  const tracker = new TurnActivityTracker("thread", "turn", (entry) => updates.push(entry));
  const send = (method: string, fields: object) => tracker.observe(method, { threadId: "thread", turnId: "turn", ...fields });
  return { updates, tracker, send };
}

test("activity scopes notifications and withholds unknown/raw fields", () => {
  const { updates, tracker, send } = setup();
  tracker.observe("item/started", null);
  send("item/started", { threadId: "other", item: { id: "1", type: "commandExecution" } });
  send("item/started", { turnId: "other", item: { id: "1", type: "commandExecution" } });
  send("item/started", { item: { id: "1", type: "unknown", content: "private" } });
  assert.equal(updates.length, 0);
  send("item/started", { item: { id: "1", type: "mcpToolCall", tool: "lookup", arguments: "private", result: "private" } });
  assert.equal(updates[0].detail, "lookup\n");
  assert.ok(!JSON.stringify(updates).includes("private"));
});

test("command output buffers split credentials and completes with exit status", () => {
  const { updates, send } = setup();
  send("item/started", { item: { id: "1", type: "commandExecution", command: "npm test" } });
  send("item/commandExecution/requestApproval", { itemId: "1", requestId: 42 });
  assert.equal(updates.at(-1)?.status, "Awaiting approval");
  send("serverRequest/resolved", { requestId: 42, turnId: undefined });
  assert.equal(updates.at(-1)?.status, "Approval resolved; waiting for activity");
  send("item/commandExecution/outputDelta", { itemId: "1", delta: "token=sec" });
  assert.ok(!updates.at(-1)?.detail.includes("sec"));
  send("item/commandExecution/outputDelta", { itemId: "1", delta: "ret\nTests failed\n" });
  assert.match(updates.at(-1)!.detail, /REDACTED.*\nTests failed/);
  assert.equal(updates.at(-1)?.status, "Running");
  send("item/completed", { item: { id: "1", type: "commandExecution", exitCode: 1 } });
  assert.equal(updates.at(-1)?.status, "Failed (exit 1)");
  assert.ok(updates.at(-1)?.finishedAt);
});

test("reasoning uses public summaries only and finalises unfinished items", () => {
  const { updates, tracker, send } = setup();
  send("item/started", { item: { id: "1", type: "reasoning", content: ["hidden"] } });
  send("item/reasoning/textDelta", { itemId: "1", delta: "hidden" });
  send("item/reasoning/summaryTextDelta", { itemId: "1", summaryIndex: 0, delta: "Checking tests" });
  send("item/completed", { item: { id: "1", type: "reasoning", summary: ["Checking tests"] } });
  assert.equal(updates.at(-1)?.detail, "Checking tests");
  assert.ok(!JSON.stringify(updates).includes("hidden"));
  send("item/started", { item: { id: "2", type: "fileChange", changes: [{ path: "src/file.ts", diff: "private diff" }] } });
  tracker.finish("cancelled");
  assert.equal(updates.at(-1)?.detail, "src/file.ts");
  assert.match(updates.at(-1)!.status, /cancelled/);
  assert.ok(updates.at(-1)?.finishedAt);
});

test("feed bounds entry count and output length", () => {
  const { updates, send } = setup();
  for (let index = 0; index < 120; index++) send("item/started", { item: { id: String(index), type: "commandExecution" } });
  assert.equal(updates.length, 100);
  send("item/commandExecution/outputDelta", { itemId: "0", delta: "x".repeat(30_000) + "\n" });
  assert.ok(updates.at(-1)!.detail.length <= 16_384);
});
