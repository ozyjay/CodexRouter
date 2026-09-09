import assert from "node:assert/strict";
import test from "node:test";
import { CodexModel } from "../src/contracts";
import { buildTurnPlan, phasePrompt, singleTurnPlan, turnPlanValidationIssues } from "../src/orchestration";
import { fallbackRoute } from "../src/routing";

const models: CodexModel[] = [
  { id: "luna", model: "gpt-5.6-luna", displayName: "Luna", description: "", hidden: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }], isDefault: false },
  { id: "terra", model: "gpt-5.6-terra", displayName: "Terra", description: "", hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], isDefault: true },
  { id: "sol", model: "gpt-5.6-sol", displayName: "Sol", description: "", hidden: false, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }], isDefault: false }
];

test("local turn plans accept only bounded ordered phases and live allocations", () => {
  const valid = {
    strategy: "sequential-turns" as const,
    turns: [
      { phase: "exploration" as const, model: "gpt-5.6-luna", effort: "low" },
      { phase: "implementation" as const, model: "gpt-5.6-terra", effort: "medium" },
      { phase: "review" as const, model: "gpt-5.6-sol", effort: "high" }
    ],
    reasons: ["The task needs separate discovery and review."]
  };
  assert.deepEqual(turnPlanValidationIssues(valid, models), []);
  assert.ok(turnPlanValidationIssues({ ...valid, turns: [...valid.turns].reverse() }, models).includes("phase-order"));
  assert.ok(turnPlanValidationIssues({ ...valid, turns: [{ phase: "implementation", model: "unknown", effort: "low" }] }, models).includes("turn-allocation"));
  assert.ok(turnPlanValidationIssues({ strategy: "single-turn", turns: [{ phase: "review", model: "gpt-5.6-sol", effort: "high" }], reasons: ["Review only."] }, models).includes("strategy-turns"));
});

test("turn-plan allocations retain deterministic high-risk guardrails", () => {
  const input = { task: "Rotate production OAuth credentials without data loss." };
  const base = { ...fallbackRoute(input), source: "local-model" as const, classifierModel: "local-router" };
  const plan = buildTurnPlan({
    strategy: "sequential-turns",
    turns: [
      { phase: "exploration", model: "gpt-5.6-luna", effort: "low" },
      { phase: "implementation", model: "gpt-5.6-terra", effort: "medium" }
    ],
    reasons: ["Credentials work benefits from a separate inspection turn."]
  }, input, models, base);
  assert.deepEqual(plan.turns.map((turn) => [turn.recommendation.recommendedModel, turn.recommendation.recommendedEffort]), [
    ["gpt-5.6-sol", "high"],
    ["gpt-5.6-sol", "high"]
  ]);
  assert.ok(plan.turns.every((turn) => turn.recommendation.providerFallback === "guardrail-escalation"));
});

test("phase prompts are deterministic and later turns do not repeat the original task", () => {
  assert.match(phasePrompt("exploration", 1, 3, "Implement the feature"), /^Implement the feature/);
  assert.match(phasePrompt("exploration", 1, 3), /Do not edit files/);
  assert.doesNotMatch(phasePrompt("implementation", 2, 3), /Implement the feature/);
  assert.match(phasePrompt("review", 3, 3), /Fix any issues/);
});

test("single-turn fallback preserves the routed recommendation", () => {
  const recommendation = fallbackRoute({ task: "Fix one typo." });
  assert.equal(singleTurnPlan(recommendation, "malformed").turns[0].recommendation, recommendation);
  assert.equal(singleTurnPlan(recommendation, "malformed").providerFallback, "malformed");
});
