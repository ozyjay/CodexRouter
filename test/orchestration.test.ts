import assert from "node:assert/strict";
import test from "node:test";
import { CodexModel } from "../src/contracts";
import { TurnResultSummaryCollector, buildReplannedTurns, buildTurnPlan, phasePrompt, singleTurnPlan, turnPlanValidationIssues, turnReplanValidationIssues } from "../src/orchestration";
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

test("adaptive replans can stop after implementation or add only later phases", () => {
  assert.deepEqual(turnReplanValidationIssues({ decision: "complete", turns: [], reasons: ["Implementation completed with verification."] }, models, ["implementation"]), []);
  const review = { decision: "continue" as const, turns: [{ phase: "review" as const, model: "gpt-5.6-sol", effort: "high" }], reasons: ["Verification remains uncertain."] };
  assert.deepEqual(turnReplanValidationIssues(review, models, ["implementation"]), []);
  assert.ok(turnReplanValidationIssues({ ...review, turns: [{ phase: "exploration", model: "gpt-5.6-luna", effort: "low" }] }, models, ["implementation"]).includes("phase-order"));
  assert.ok(turnReplanValidationIssues({ decision: "complete", turns: [], reasons: ["Too early."] }, models, ["exploration"]).includes("implementation-required"));
  const base = { ...fallbackRoute({ task: "Implement a parser." }), source: "local-model" as const };
  assert.equal(buildReplannedTurns(review, { task: "Implement a parser." }, models, base, ["implementation"])[0].phase, "review");
});

test("adaptive result summaries are bounded and redact common credentials", () => {
  const collector = new TurnResultSummaryCollector();
  collector.push(`Finished with token sk-${"a".repeat(32)} and verification passed.`);
  assert.doesNotMatch(collector.summary(), /sk-/);
  assert.match(collector.summary(), /REDACTED TOKEN/);
  const oversized = new TurnResultSummaryCollector();
  oversized.push("x".repeat(65_537));
  assert.match(oversized.summary(), /withheld/);
});
