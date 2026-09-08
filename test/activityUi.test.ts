import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { activityScript } from "../src/activityUi";
import { markdownScript } from "../src/markdownUi";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

test("stop control stays visible and disabled until the turn ends, and allows retry", () => {
  const source = readFileSync("src/extension.ts", "utf8");
  const script = source.split('<script nonce="${nonce}">')[1].split("</script>")[0]
    .replace("${markdownScript}", markdownScript).replace("${activityScript}", activityScript);
  new Script(script);
  const stateFunction = script.slice(script.indexOf("function setUiState("), script.indexOf("function updateEfforts("));
  const element = () => ({ disabled: false, hidden: false, value: "", textContent: "", style: { display: "" }, querySelector: () => ({ open: false }) });
  const cancel = element();
  const task = element();
  const activityMessage = element();
  const context = { cancel, task, activityMessage, uiState: "idle", document: { getElementById: element }, metadata: element(), provider: element(), accept: element(), override: element(), model: element(), effort: element(), recommendation: element(), activity: element(), spinner: element() };
  runInNewContext(stateFunction + "setUiState('running','Working');", context);
  assert.equal(cancel.textContent, "Stop model");
  assert.equal(cancel.style.display, "block");
  runInNewContext(stateFunction + "setUiState('stopping','Waiting for confirmation');", context);
  assert.equal(cancel.textContent, "Stopping…");
  assert.equal(cancel.disabled, true);
  assert.equal(task.disabled, true);
  runInNewContext(stateFunction + "setUiState('running','Stop failed; retry');", context);
  assert.equal(cancel.disabled, false);
  runInNewContext(stateFunction + "setUiState('idle','');", context);
  assert.equal(cancel.style.display, "none");
  assert.equal(task.disabled, false);
});

test("streaming follows the latest output without pulling readers away from earlier messages", () => {
  const source = readFileSync("src/extension.ts", "utf8");
  const start = source.indexOf("function updateAssistant(");
  const end = source.indexOf("function updateEfforts(", start);
  const rendered: string[] = [];
  const context = { assistantMessage: {}, assistantText: "Initial", renderMarkdown: (_target: unknown, text: string) => rendered.push(text), conversation: { scrollHeight: 1000, scrollTop: 600, clientHeight: 400 } };
  runInNewContext(source.slice(start, end) + "updateAssistant(' output',true);", context);
  assert.equal(context.assistantText, "Initial output");
  assert.equal(rendered.at(-1), "Initial output");
  assert.equal(context.conversation.scrollTop, 1000);
  context.conversation.scrollTop = 100;
  runInNewContext("updateAssistant('More output',false);", context);
  assert.equal(context.assistantText, "More output");
  assert.equal(rendered.at(-1), "More output");
  assert.equal(context.conversation.scrollTop, 100);
});

test("composer submits through routing once and ignores empty or locked submissions", () => {
  const source = readFileSync("src/extension.ts", "utf8");
  const start = source.indexOf("function submit(){");
  const end = source.indexOf("document.getElementById('submit').addEventListener", start);
  const messages: unknown[] = [];
  const context = {
    task: { value: "  Add a focused test.  " }, metadata: { checked: true }, uiState: "idle",
    assistantMessage: undefined, resizeTask() {}, addMessage() { return {}; },
    setUiState(state: string) { context.uiState = state; },
    post(value: unknown) { messages.push(value); }
  };
  runInNewContext(source.slice(start, end) + "submit();", context);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: "submit", task: "Add a focused test.", includeMetadata: true }]);
  assert.equal(context.task.value, "");
  context.task.value = "Do not submit during approval.";
  for (const state of ["analysing", "awaiting-approval", "starting", "running", "stopping"]) {
    context.uiState = state;
    runInNewContext("submit();", context);
  }
  context.uiState = "idle";
  context.task.value = "   ";
  runInNewContext("submit();", context);
  assert.equal(messages.length, 1);
});

test("activity UI renders literal text, retains separate turn feeds and clears timers", () => {
  class Element {
    textContent = "";
    className = "";
    children: Element[] = [];
    append(...elements: Element[]) { this.children.push(...elements); }
    replaceChildren(...elements: Element[]) { this.children = elements; }
    setAttribute() {}
  }
  const listeners = new Map<string, (event: { data: unknown }) => void>();
  const conversation = new Element();
  const activityMessage = new Element();
  let now = 1000;
  let tick: (() => void) | undefined;
  runInNewContext(activityScript, {
    document: { createElement: () => new Element() }, conversation, activityMessage,
    window: { addEventListener: (name: string, listener: (event: { data: unknown }) => void) => listeners.set(name, listener) },
    Date: { now: () => now },
    setInterval: (callback: () => void) => { tick = callback; return 1; },
    clearInterval: () => { tick = undefined; }
  });
  const send = (data: unknown) => listeners.get("message")!({ data });
  send({ type: "activity", state: "running" });
  now = 6000;
  tick!();
  const feed = conversation.children[0];
  assert.match(feed.children[1].textContent, /No new activity for 5s/);
  send({ type: "turn-activity", value: { id: "one", label: "Command", status: "Running", startedAt: 1000, detail: "<script>unsafe()</script>" } });
  assert.equal(feed.children[3].children[0].children[1].textContent, "<script>unsafe()</script>");
  assert.equal(activityMessage.textContent, "Command · Running");
  send({ type: "turn-activity", value: { id: "two", label: "Reasoning summary", status: "Completed", startedAt: 6000, finishedAt: 6000, detail: "" } });
  assert.equal(feed.children[4].children.length, 1);
  assert.equal(feed.children[4].children[0].children.length, 0);
  assert.doesNotMatch(feed.children[4].children[0].textContent, /No details supplied/);
  send({ type: "finished" });
  assert.equal(tick, undefined);
  assert.match(feed.children[1].textContent, /Turn ended/);
  send({ type: "activity", state: "running" });
  assert.equal(conversation.children.length, 2);
  send({ type: "conversation-reset" });
  assert.equal(tick, undefined);
});
