import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexModel } from "../src/contracts";
import { EvaluationManifest, buildPrompt, classifyCodexFailure, roleAgentFiles, summariseEvaluationRuns, validateAllocations, validateEvaluationManifest } from "../src/evaluation";
import { linkInstalledDependencies } from "../scripts/baseline-eval";

const manifest: EvaluationManifest = {
  version: 1,
  singleModel: { model: "terra", effort: "medium" },
  fixedRoles: {
    parent: { model: "terra", effort: "medium" },
    explorer: { model: "luna", effort: "low" },
    worker: { model: "terra", effort: "medium" },
    reviewer: { model: "sol", effort: "high" }
  },
  cases: [{ id: "focused-test", prompt: "Add one test.", validation: { command: "npm", args: ["run", "check"] }, expectation: { file: "test/routing.test.ts", requiredPatterns: ["focused test"] } }]
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
    { caseId: "focused-test", iteration: 1, strategy: "single-model", allocations: { singleModel: manifest.singleModel }, durationMs: 100, codexExitCode: 0, validationExitCode: 0, expectationPassed: true, changedFiles: true, completedAt: "2026-08-29T00:00:00.000Z" },
    { caseId: "focused-test", iteration: 1, strategy: "fixed-roles", allocations: manifest.fixedRoles, durationMs: 200, codexExitCode: 0, validationExitCode: 1, expectationPassed: false, changedFiles: true, completedAt: "2026-08-29T00:00:00.000Z" }
  ]);
  assert.equal(summary.totalRuns, 2);
  assert.equal(summary.validationPassedRuns, 1);
  assert.equal(summary.expectationPassedRuns, 1);
  assert.equal(summary.verifiedRuns, 1);
  assert.equal(summary.byStrategy["single-model"].verified, 1);
  assert.equal(summary.byStrategy["fixed-roles"].expectationPassed, 0);
  assert.equal(summary.averageDurationMs, 150);
  assert.equal(JSON.stringify(summary).includes("Add one test"), false);
});

test("evaluation manifest accepts only safe, meaningful diff expectations", () => {
  assert.deepEqual(validateEvaluationManifest(manifest), []);
  const invalid = { ...manifest, cases: [{ ...manifest.cases[0], expectation: { file: "../secret", requiredPatterns: [] } }] };
  assert.match(validateEvaluationManifest(invalid).join(" "), /expectation/);
});

test("validation dependencies are linked only when requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-evaluation-test-"));
  try {
    await linkInstalledDependencies(directory);
    assert.equal(await realpath(join(directory, "node_modules")), await realpath(resolve("node_modules")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex launcher failures are classified without retaining stderr", () => {
  assert.equal(classifyCodexFailure("error: unexpected argument --approve-for-me", 2), "cli-configuration");
  assert.equal(classifyCodexFailure("Please log in before continuing", 1), "authentication");
  assert.equal(classifyCodexFailure("selected model is unavailable", 1), "model-allocation");
});
