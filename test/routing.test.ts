import assert from "node:assert/strict";
import test from "node:test";
import { CodexModel } from "../src/contracts";
import { applyGuardrails, assessTask, deterministicRoute, fallbackRoute, isValidRecommendation, selectCatalogueAllocation, selectEffort, selectModel } from "../src/routing";

const models: CodexModel[] = [
  { id: "luna", model: "gpt-5.6-luna", displayName: "Luna", description: "", hidden: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], isDefault: false },
  { id: "terra", model: "gpt-5.6-terra", displayName: "Terra", description: "", hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], isDefault: true },
  { id: "sol", model: "gpt-5.6-sol", displayName: "Sol", description: "", hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }], isDefault: false }
];

test("deterministic fallback uses Luna for narrow mechanical work", () => {
  const route = fallbackRoute({ task: "Fix the README typo in the installation command." });
  assert.equal(route.recommendedModel, "gpt-5.6-luna");
  assert.equal(route.recommendedEffort, "low");
  assert.equal(route.strength, "strong");
});

test("deterministic baseline distinguishes ordinary, broad and consequential work", () => {
  assert.equal(fallbackRoute({ task: "Implement a bounded parser fix and update its tests." }).recommendedModel, "gpt-5.6-terra");
  assert.equal(fallbackRoute({ task: "Redesign architecture across the repository." }).recommendedModel, "gpt-5.6-sol");
  const consequential = fallbackRoute({ task: "Migrate credentials while preserving data integrity." });
  assert.equal(consequential.recommendedModel, "gpt-5.6-sol");
  assert.deepEqual(consequential.assessment.riskSignals, ["credentials", "migration", "data-integrity"]);
});

test("documentation context avoids keyword-only security escalation", () => {
  const route = fallbackRoute({ task: "Document the OAuth authentication flow in the README." });
  assert.deepEqual(route.assessment.riskSignals, []);
  assert.notEqual(route.risk, "high");
});

test("assessment exposes every transparent policy dimension", () => {
  assert.deepEqual(Object.keys(assessTask({ task: "Investigate a concurrency race across the codebase." })).sort(), [
    "ambiguity", "architecturalJudgement", "blastRadius", "boundedRepeatable", "exploration", "reversibility", "riskSignals", "scope", "verificationBurden"
  ]);
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
  assert.equal(selectEffort("unknown-future-value", models[1]), "medium");
  assert.throws(() => selectEffort("low", { ...models[1], supportedReasoningEfforts: [] }), /no supported reasoning efforts/);
});

test("catalogue fallback is deterministic and disclosed", () => {
  const withoutSol = models.slice(0, 2);
  const allocation = selectCatalogueAllocation("sol", "high", withoutSol);
  assert.equal(allocation.model.model, "gpt-5.6-terra");
  assert.equal(allocation.effort, "high");
  assert.equal(allocation.fallback?.reason, "model-tier-unavailable");
});

test("hidden models are excluded while an advertised visible model exists", () => {
  const hiddenSol = { ...models[2], hidden: true };
  assert.equal(selectModel("sol", [models[1], hiddenSol]).model, "gpt-5.6-terra");
});

test("unrecognised catalogues use the advertised default and disclose the fallback", () => {
  const catalogue: CodexModel[] = [{ ...models[1], id: "current", model: "gpt-current" }];
  const route = deterministicRoute({ task: "Add a unit test." }, catalogue);
  assert.equal(route.recommendedModel, "gpt-current");
  assert.equal(route.catalogueFallback?.reason, "unrecognised-catalogue");
});

test("routing response validation rejects malformed or excessive advice", () => {
  assert.equal(isValidRecommendation({ recommendedModel: "gpt-5.6-terra", recommendedEffort: "medium", confidence: 1.5, reasons: [], escalationSignals: [] }), false);
  const valid = {
    taskType: "testing",
    scope: "narrow",
    complexity: "low",
    risk: "normal",
    ambiguity: "low",
    recommendedModel: "gpt-5.6-luna",
    recommendedEffort: "low",
    confidence: 0.8,
    reasons: ["Bounded test change."],
    escalationSignals: []
  };
  assert.equal(isValidRecommendation(valid), true);
  assert.equal(isValidRecommendation({ ...valid, unexpected: "field" }), false);
});
