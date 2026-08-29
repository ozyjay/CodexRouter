import assert from "node:assert/strict";
import test from "node:test";
import { CodexModel } from "../src/contracts";
import { EvaluationManifest, buildPrompt, roleAgentFiles, summariseEvaluationRuns, validateAllocations, validateEvaluationManifest } from "../src/evaluation";

const manifest: EvaluationManifest = {
  version: 1,
  singleModel: { model: "terra", effort: "medium" },
  fixedRoles: {
    parent: { model: "terra", effort: "medium" },
    explorer: { model: "luna", effort: "low" },
    worker: { model: "terra", effort: "medium" },
    reviewer: { model: "sol", effort: "high" }
  },
  cases: [{ id: "focused-test", prompt: "Add one test.", validation: { command: "npm", args: ["run", "check"] } }]
};

const models: CodexModel[] = [
  { id: "luna", model: "gpt-5.6-luna", displayName: "Luna", description: "", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", isDefault: false },
  { id: "terra", model: "gpt-5.6-terra", displayName: "Terra", description: "", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium", isDefault: true },
  { id: "sol", model: "gpt-5.6-sol", displayName: "Sol", description: "", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high", isDefault: false }
];

test("evaluation manifest and live allocations are validated", () => {
  assert.deepEqual(validateEvaluationManifest(manifest), []);
  assert.deepEqual(validateAllocations(manifest, models), []);
  assert.deepEqual(validateAllocations({ ...manifest, fixedRoles: { ...manifest.fixedRoles, reviewer: { model: "sol", effort: "max" } } }, models), ["reviewer selects unsupported effort max for sol."]);
  assert.match(validateEvaluationManifest({ version: 1, cases: [] }).join(" "), /singleModel/);
});

test("fixed-role prompt and files remain sequential and role-scoped", () => {
  const prompt = buildPrompt("fixed-roles", manifest.cases[0]);
  assert.match(prompt, /sequentially and without parallel delegation/);
  assert.match(prompt, /router_baseline_explorer/);
  const files = roleAgentFiles(manifest.fixedRoles);
  assert.match(files["router-baseline-explorer.toml"], /sandbox_mode = "read-only"/);
  assert.match(files["router-baseline-worker.toml"], /sandbox_mode = "workspace-write"/);
  assert.match(files["router-baseline-reviewer.toml"], /model_reasoning_effort = "high"/);
});

test("evaluation summary excludes prompts and aggregates verification", () => {
  const summary = summariseEvaluationRuns([
    { caseId: "focused-test", strategy: "single-model", allocations: { singleModel: manifest.singleModel }, durationMs: 100, codexExitCode: 0, validationExitCode: 0, changedFiles: true, completedAt: "2026-08-29T00:00:00.000Z" },
    { caseId: "focused-test", strategy: "fixed-roles", allocations: manifest.fixedRoles, durationMs: 200, codexExitCode: 0, validationExitCode: 1, changedFiles: true, completedAt: "2026-08-29T00:00:00.000Z" }
  ]);
  assert.equal(summary.totalRuns, 2);
  assert.equal(summary.validationPassedRuns, 1);
  assert.equal(summary.averageDurationMs, 150);
  assert.equal(JSON.stringify(summary).includes("Add one test"), false);
});
