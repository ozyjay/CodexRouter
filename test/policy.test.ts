import assert from "node:assert/strict";
import test from "node:test";
import { CodexModel } from "../src/contracts";
import { recommendWithProvider } from "../src/policy";
import { fallbackRoute } from "../src/routing";

const models: CodexModel[] = [
  { id: "luna", model: "gpt-5.6-luna", displayName: "Luna", description: "", hidden: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }], isDefault: false },
  { id: "terra", model: "gpt-5.6-terra", displayName: "Terra", description: "", hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], isDefault: true },
  { id: "sol", model: "gpt-5.6-sol", displayName: "Sol", description: "", hidden: false, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }], isDefault: false }
];

test("deterministic provider is the default path and never constructs a classifier", async () => {
  let classifierCreated = false;
  const route = await recommendWithProvider({ task: "Fix the README typo." }, models, "deterministic", () => {
    classifierCreated = true;
    throw new Error("must not be called");
  });
  assert.equal(classifierCreated, false);
  assert.equal(route.source, "deterministic");
});

test("unsupported experimental allocations fall back visibly", async () => {
  const input = { task: "Implement a bounded parser fix." };
  const route = await recommendWithProvider(input, models, "modeldeck-experimental", () => ({
    classify: async () => ({ ...fallbackRoute(input), source: "local-model", classifierModel: "local-router", recommendedModel: "missing-model" })
  }));
  assert.equal(route.source, "deterministic");
  assert.equal(route.providerFallback, "unsupported-allocation");
});

test("experimental classifiers cannot weaken deterministic safety guardrails", async () => {
  const input = { task: "Rotate production OAuth credentials without data loss." };
  const weak = { ...fallbackRoute({ task: "Fix the README typo." }), source: "local-model" as const, classifierModel: "local-router" };
  const route = await recommendWithProvider(input, models, "modeldeck-experimental", () => ({ classify: async () => weak }));
  assert.equal(route.recommendedModel, "gpt-5.6-sol");
  assert.equal(route.recommendedEffort, "high");
  assert.equal(route.providerFallback, "guardrail-escalation");

  const weakEffort = { ...weak, recommendedModel: "gpt-5.6-sol", recommendedEffort: "low" };
  const effortRoute = await recommendWithProvider(input, models.map((model) => model.id === "sol" ? { ...model, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] } : model), "modeldeck-experimental", () => ({ classify: async () => weakEffort }));
  assert.equal(effortRoute.recommendedEffort, "high");
  assert.equal(effortRoute.providerFallback, "guardrail-escalation");
});
