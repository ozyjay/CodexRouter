import assert from "node:assert/strict";
import test from "node:test";
import { CodexModel, RoutingRecommendation } from "../src/contracts";
import { applyGuardrails, fallbackRoute, isValidRecommendation, selectEffort } from "../src/routing";

const models: CodexModel[] = [
  { id: "luna", model: "gpt-5.6-luna", displayName: "Luna", description: "", hidden: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], isDefault: false },
  { id: "terra", model: "gpt-5.6-terra", displayName: "Terra", description: "", hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], isDefault: true },
  { id: "sol", model: "gpt-5.6-sol", displayName: "Sol", description: "", hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }], isDefault: false }
];

test("deterministic fallback uses Luna for narrow mechanical work", () => {
  const route = fallbackRoute({ task: "Fix the README typo in the installation command." });
  assert.equal(route.recommendedModel, "gpt-5.6-luna");
  assert.equal(route.recommendedEffort, "low");
});

test("deterministic guardrails escalate authentication work", () => {
  const candidate = fallbackRoute({ task: "Rename a variable." });
  const route = applyGuardrails(candidate, { task: "Add OAuth token rotation to authentication." }, models);
  assert.equal(route.recommendedModel, "gpt-5.6-sol");
  assert.equal(route.recommendedEffort, "high");
  assert.equal(route.risk, "high");
});

test("unsupported effort is rounded up to a supported effort", () => {
  assert.equal(selectEffort("low", models[1]), "medium");
});

test("routing response validation rejects malformed or excessive advice", () => {
  assert.equal(isValidRecommendation({ recommendedModel: "gpt-5.6-terra", recommendedEffort: "medium", confidence: 1.5, reasons: [], escalationSignals: [] }), false);
  const valid: RoutingRecommendation = fallbackRoute({ task: "Add a unit test." });
  assert.equal(isValidRecommendation(valid), true);
});
