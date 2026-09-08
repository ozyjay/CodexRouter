import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { activityScript } from "../src/activityUi";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

test("stop control stays visible and disabled until the turn ends, and allows retry", () => {
  const source = readFileSync("src/extension.ts", "utf8");
  const script = source.split('<script nonce="${nonce}">')[1].split("</script>")[0].replace("${activityScript}", activityScript);
  new Script(script);
  const stateFunction = script.slice(script.indexOf("function setUiState("), script.indexOf("function updateEfforts("));
  const element = () => ({ disabled: false, hidden: false, textContent: "", style: { display: "" } });
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

test("activity UI renders literal text, retains separate turn feeds and clears timers", () => {
  class Element {
    textContent = "";
    className = "";
    children: Element[] = [];
    append(...elements: Element[]) { this.children.push(...elements); }
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
  assert.equal(feed.children[3].children[1].textContent, "<script>unsafe()</script>");
  assert.equal(activityMessage.textContent, "Command · Running");
  send({ type: "finished" });
  assert.equal(tick, undefined);
  assert.match(feed.children[1].textContent, /Turn ended/);
  send({ type: "activity", state: "running" });
  assert.equal(conversation.children.length, 2);
  send({ type: "conversation-reset" });
  assert.equal(tick, undefined);
});
