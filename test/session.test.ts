import assert from "node:assert/strict";
import test from "node:test";
import { CodexModel, RoutingSessionInput } from "../src/contracts";
import { fallbackRoute } from "../src/routing";
import { RoutingSessionController, buildExecutionPrompt } from "../src/session";

const models: CodexModel[] = [
  { id: "luna", model: "gpt-5.6-luna", displayName: "Luna", description: "", hidden: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }], isDefault: false },
  { id: "terra", model: "gpt-5.6-terra", displayName: "Terra", description: "", hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], isDefault: true }
];

const input: RoutingSessionInput = {
  routing: { task: "Fix one test.", metadata: { languageId: "typescript", relativeFileName: "test/example.test.ts", selectionPresent: true, selectedCharacters: 21 } },
  execution: { task: "Fix one test.", selectedExcerpt: { content: "secret source excerpt", relativeFileName: "test/example.test.ts" } }
};

test("routing session separates routing metadata from approved execution source", async () => {
  let routingPayload = "";
  let executionPrompt = "";
  const session = new RoutingSessionController(input, async (routing) => {
    routingPayload = JSON.stringify(routing);
    return fallbackRoute(routing);
  }, { execute: async (prompt) => { executionPrompt = prompt; return "completed"; } });
  await session.analyse(models);
  session.awaitApproval();
  const summary = session.contextSummary();
  assert.doesNotMatch(routingPayload, /secret source excerpt/);
  assert.match(summary.routing, /source withheld/);
  assert.doesNotMatch(summary.routing, /secret source excerpt/);
  assert.match(summary.execution, /approved 21-character selected excerpt/);
  session.acceptRecommendation();
  assert.equal(await session.execute(), "completed");
  assert.match(executionPrompt, /secret source excerpt/);
});

test("routing session requires explicit acceptance and constrains overrides", async () => {
  const session = new RoutingSessionController(input, async (routing) => fallbackRoute(routing), { execute: async () => "completed" });
  await session.analyse(models);
  session.awaitApproval();
  await assert.rejects(session.execute(), /Explicit acceptance or override/);
  assert.throws(() => session.override("hidden-model", "low", models), /not selectable/);
  assert.throws(() => session.override("gpt-5.6-terra", "low", models), /not supported/);
  assert.deepEqual(session.override("gpt-5.6-terra", "high", models), { model: "gpt-5.6-terra", effort: "high", overridden: true });
});

test("routing session cancellation remains active throughout execution", async () => {
  const session = new RoutingSessionController(input, async (routing) => fallbackRoute(routing), {
    execute: async (_prompt, _selection, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve("cancelled"), { once: true }))
  });
  await session.analyse(models);
  session.awaitApproval();
  session.acceptRecommendation();
  const execution = session.execute();
  assert.equal(session.cancel(), true);
  assert.equal(await execution, "cancelled");
  assert.equal(session.state, "cancelled");
});

test("execution prompt excludes source unless it is explicitly present", () => {
  assert.equal(buildExecutionPrompt({ routing: { task: "Task" }, execution: { task: "Task" } }), "Task");
});
