import assert from "node:assert/strict";
import test from "node:test";
import { SidebarConversation } from "../src/conversation";

test("sidebar follow-ups reuse a thread across allocation changes and reset explicitly", async () => {
  const calls: Array<{ prompt: string; model: string; effort: string; threadId?: string }> = [];
  const server = {
    generation: 1,
    async startTurn(prompt: string, _cwd: string, model: string, effort: string, threadId?: string) {
      calls.push({ prompt, model, effort, threadId });
      return { threadId: threadId ?? `thread-${calls.length}`, turnId: `turn-${calls.length}` };
    }
  };
  const conversation = new SidebarConversation();
  await conversation.startTurn(server, "Invent a novel game", "/workspace", { model: "sol", effort: "high", overridden: false });
  await conversation.startTurn(server, "Write this as a proposal", "/workspace", { model: "terra", effort: "medium", overridden: true });
  assert.equal(calls[1].threadId, "thread-1");
  assert.equal(calls[1].model, "terra");
  assert.equal(calls[1].effort, "medium");
  const independent = new SidebarConversation();
  await independent.startTurn(server, "Unrelated task", "/workspace", { model: "terra", effort: "low", overridden: false });
  assert.equal(calls[2].threadId, undefined);
  conversation.reset();
  assert.equal(conversation.hasContext, false);
  await conversation.startTurn(server, "Fresh task", "/workspace", { model: "terra", effort: "low", overridden: false });
  assert.equal(calls[3].threadId, undefined);
});

test("a changed workspace or restarted process cannot silently lose conversation context", async () => {
  let calls = 0;
  const server = { generation: 1, async startTurn() { calls++; return { threadId: "thread", turnId: "turn" }; } };
  const conversation = new SidebarConversation();
  const allocation = { model: "model", effort: "low", overridden: false };
  await conversation.startTurn(server, "First task", "/one", allocation);
  await assert.rejects(conversation.startTurn(server, "Follow-up", "/two", allocation), /New conversation/);
  server.generation++;
  await assert.rejects(conversation.startTurn(server, "Follow-up", "/one", allocation), /New conversation/);
  assert.equal(calls, 1);
});

test("failed follow-ups retain the thread and disposal during start cannot restore it", async () => {
  const conversation = new SidebarConversation();
  let fail = false;
  const server = { generation: 1, async startTurn() {
    if (fail) throw new Error("start failed");
    return { threadId: "thread", turnId: "turn" };
  } };
  const allocation = { model: "model", effort: "low", overridden: false };
  await conversation.startTurn(server, "First task", "/workspace", allocation);
  fail = true;
  await assert.rejects(conversation.startTurn(server, "Follow-up", "/workspace", allocation));
  assert.equal(conversation.hasContext, true);
  conversation.reset();
  fail = false;
  const pending = conversation.startTurn(server, "First task", "/workspace", allocation);
  conversation.reset();
  await pending;
  assert.equal(conversation.hasContext, false);
});
