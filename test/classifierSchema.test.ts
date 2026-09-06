import assert from "node:assert/strict";
import test from "node:test";
import { CLASSIFIER_SCHEMA, classifierValidationIssues, normaliseClassifierRisk } from "../src/classifierSchema";
import { isValidRecommendation } from "../src/routing";

const candidate = { taskType: "other", scope: "broad", complexity: "high", risk: "normal", ambiguity: "high", recommendedModel: "current", recommendedEffort: "high", confidence: 0.7, reasons: ["Creative brainstorming."], escalationSignals: [] };

test("creative complexity can be high with normal risk and no escalation", () => {
  assert.equal(isValidRecommendation(candidate), true);
  assert.deepEqual(CLASSIFIER_SCHEMA.properties.risk.enum, ["normal", "elevated", "high"]);
});

test("the observed low risk alias is normalised without accepting unknown values", () => {
  assert.equal(isValidRecommendation(normaliseClassifierRisk({ ...candidate, risk: "low" })), true);
  assert.equal((normaliseClassifierRisk({ ...candidate, risk: "low" }) as typeof candidate).risk, "normal");
  assert.deepEqual(classifierValidationIssues(normaliseClassifierRisk({ ...candidate, risk: "safe" })), ["risk"]);
  assert.equal((normaliseClassifierRisk({ ...candidate, risk: "high" }) as typeof candidate).risk, "high");
});

test("schema errors identify fields without exposing arbitrary output", () => {
  assert.deepEqual(classifierValidationIssues({ ...candidate, confidence: 2, reasons: ["x".repeat(241)], "private extra": "private content" }), ["confidence", "reasons", "unexpected-fields"]);
  assert.deepEqual(classifierValidationIssues({ ...candidate, recommendedModel: "model\nspoofed-log" }), ["recommendedModel"]);
  assert.deepEqual(classifierValidationIssues({ ...candidate, escalationSignals: [" "] }), ["escalationSignals"]);
  assert.deepEqual(classifierValidationIssues({ ...candidate, reasons: ["line\n"] }), ["reasons"]);
});
