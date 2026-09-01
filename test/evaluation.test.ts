import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexModel } from "../src/contracts";
import { EvaluationManifest, buildPrompt, classifyCodexFailure, roleAgentFiles, simulationPatchForProfile, summariseEvaluationRuns, validateAllocations, validateEvaluationManifest } from "../src/evaluation";
import { allocationsForRun, assertCapabilitySnapshot, capabilityRouteIdsFor, linkInstalledDependencies, proxyModelsForReadiness, readProxyContext, resolveEvaluationRef, runMutationCheck, runSimulation, strategiesForExecutionBackend } from "../scripts/baseline-eval";

const manifest: EvaluationManifest = {
  version: 1,
  singleModel: { model: "terra", effort: "medium" },
  fixedRoles: {
    parent: { model: "terra", effort: "medium" },
    explorer: { model: "luna", effort: "low" },
    worker: { model: "terra", effort: "medium" },
    reviewer: { model: "sol", effort: "high" }
  },
  cases: [{ id: "focused-test", prompt: "Add one test.", validation: { command: "npm", args: ["run", "check"] }, expectation: { file: "test/routing.test.ts", requiredPatterns: ["focused test"] }, mutation: { file: "src/routing.ts", search: "original", replacement: "mutant", validation: { command: process.execPath, args: ["-e", "process.exit(require('node:fs').readFileSync('src-routing.ts', 'utf8').includes('mutant') ? 1 : 0)"] } }, simulation: { file: "test/routing.test.ts", search: "original", replacement: "simulated" } }]
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
  assert.throws(() => buildPrompt("proxy-candidate", manifest.cases[0]), /local proxy strategy/);
});

test("evaluation summary excludes prompts and aggregates verification", () => {
  const summary = summariseEvaluationRuns([
    { caseId: "focused-test", iteration: 1, strategy: "single-model", executionBackend: "codex", allocations: { singleModel: manifest.singleModel }, durationMs: 100, executionExitCode: 0, validationExitCode: 0, expectationPassed: true, mutationKilled: true, changedFiles: true, completedAt: "2026-08-29T00:00:00.000Z" },
    { caseId: "focused-test", iteration: 1, strategy: "fixed-roles", executionBackend: "codex", allocations: manifest.fixedRoles, durationMs: 200, executionExitCode: 0, validationExitCode: 1, expectationPassed: false, mutationKilled: false, changedFiles: true, completedAt: "2026-08-29T00:00:00.000Z" }
  ]);
  assert.equal(summary.totalRuns, 2);
  assert.equal(summary.validationPassedRuns, 1);
  assert.equal(summary.expectationPassedRuns, 1);
  assert.equal(summary.mutationEvaluatedRuns, 2);
  assert.equal(summary.mutationKilledRuns, 1);
  assert.equal(summary.verifiedRuns, 1);
  assert.equal(summary.averageVerifiedDurationMs, 100);
  assert.equal(summary.costPerVerifiedRunMs, 300);
  assert.equal(summary.byStrategy["single-model"].verified, 1);
  assert.equal(summary.byStrategy["single-model"].averageVerifiedDurationMs, 100);
  assert.equal(summary.byStrategy["fixed-roles"].costPerVerifiedRunMs, null);
  assert.equal(summary.byStrategy["fixed-roles"].expectationPassed, 0);
  assert.equal(summary.averageDurationMs, 150);
  assert.equal(summary.selectorExpectedRuns, 0);
  assert.equal(summary.selectorExpectedMatchRate, null);
  assert.equal(JSON.stringify(summary).includes("Add one test"), false);
});

test("evaluation manifest accepts only safe, meaningful diff expectations", () => {
  assert.deepEqual(validateEvaluationManifest(manifest), []);
  const invalid = { ...manifest, cases: [{ ...manifest.cases[0], expectation: { file: "../secret", requiredPatterns: [] }, mutation: { file: "src/routing.ts", search: "", replacement: "", validation: { command: "npm", args: [] } }, simulation: { file: "../secret", search: "", replacement: "" } }] };
  assert.match(validateEvaluationManifest(invalid).join(" "), /expectation.*mutation.*simulation/);
});

test("evaluation manifest accepts multiple safe diff expectations", () => {
  const multiple = { ...manifest, cases: [{ ...manifest.cases[0], expectation: undefined, expectations: [{ file: "test/routing.test.ts", requiredPatterns: ["focused test"] }, { file: "README.md", requiredPatterns: ["evidence"] }] }] };
  assert.deepEqual(validateEvaluationManifest(multiple), []);
  assert.match(validateEvaluationManifest({ ...multiple, cases: [{ ...multiple.cases[0], expectations: [] }] }).join(" "), /expectations/);
});

test("evaluation manifest accepts bounded proxy constraints only", () => {
  const constrained = { ...manifest, cases: [{ ...manifest.cases[0], proxy: { allowedFiles: ["test/routing.test.ts"], contextFiles: ["test/routing.test.ts"], maxPatches: 1, maxContextChars: 512 } }] };
  assert.deepEqual(validateEvaluationManifest(constrained), []);
  const invalid = { ...constrained, cases: [{ ...constrained.cases[0], proxy: { allowedFiles: ["test/routing.test.ts"], contextFiles: ["src/routing.ts"], maxPatches: 0 } }] };
  assert.match(validateEvaluationManifest(invalid).join(" "), /proxy/);
});

test("proxy context reads only declared files within its character budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-proxy-context-test-"));
  try {
    await writeFile(join(directory, "allowed.txt"), "declared", "utf8");
    const context = await readProxyContext(directory, { allowedFiles: ["allowed.txt"], contextFiles: ["allowed.txt"], maxContextChars: 16 });
    assert.deepEqual(context, [{ file: "allowed.txt", content: "declared" }]);
    await assert.rejects(readProxyContext(directory, { allowedFiles: ["allowed.txt"], contextFiles: ["allowed.txt"], maxContextChars: 3 }), /character limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("simulated execution applies only its declared deterministic patch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-simulation-test-"));
  const evaluationCase = manifest.cases[0];
  try {
    await writeFile(join(directory, "test-routing.test.ts"), "original", "utf8");
    if (!evaluationCase.simulation || "patches" in evaluationCase.simulation) throw new Error("This fixture requires a single simulation patch.");
    const simulation = { ...evaluationCase.simulation, file: "test-routing.test.ts" };
    assert.equal((await runSimulation(directory, simulation)).exitCode, 0);
    assert.equal(await readFile(join(directory, "test-routing.test.ts"), "utf8"), "simulated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("simulated execution applies every patch in a declared deterministic scenario", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-simulation-test-"));
  try {
    await Promise.all([writeFile(join(directory, "first.txt"), "first", "utf8"), writeFile(join(directory, "second.txt"), "second", "utf8")]);
    assert.equal((await runSimulation(directory, { patches: [{ file: "first.txt", search: "first", replacement: "updated-first" }, { file: "second.txt", search: "second", replacement: "updated-second" }] })).exitCode, 0);
    assert.equal(await readFile(join(directory, "first.txt"), "utf8"), "updated-first");
    assert.equal(await readFile(join(directory, "second.txt"), "utf8"), "updated-second");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("simulation profiles select only declared deterministic patches", () => {
  const selected = simulationPatchForProfile({ ...manifest.cases[0], simulationProfiles: { "sim-small": { file: "test/routing.test.ts", search: "small", replacement: "small-result" } } }, "sim-small");
  assert.equal(selected.profile, "sim-small");
  if (!selected.patch || "patches" in selected.patch) throw new Error("This fixture requires a single simulation patch.");
  assert.equal(selected.patch?.replacement, "small-result");
  const fallback = simulationPatchForProfile(manifest.cases[0], "sim-strong");
  assert.equal(fallback.profile, "sim-strong");
  assert.equal(fallback.patch, manifest.cases[0].simulation);
});

test("evaluation summary tracks expected simulation-profile matches without case IDs", () => {
  const summary = summariseEvaluationRuns([
    { caseId: "small-case", iteration: 1, strategy: "single-model", executionBackend: "simulated", allocations: {}, durationMs: 10, executionExitCode: 0, validationExitCode: 0, expectationPassed: true, mutationKilled: null, changedFiles: true, completedAt: "2026-08-30T00:00:00.000Z", simulation: { selectedProfile: "sim-small", appliedProfile: "sim-small", expectedProfile: "sim-small", expectedProfileMatched: true, selector: "modeldeck", fallback: false } },
    { caseId: "balanced-case", iteration: 1, strategy: "single-model", executionBackend: "simulated", allocations: {}, durationMs: 10, executionExitCode: 0, validationExitCode: 0, expectationPassed: true, mutationKilled: null, changedFiles: true, completedAt: "2026-08-30T00:00:00.000Z", simulation: { selectedProfile: "sim-strong", appliedProfile: "sim-strong", expectedProfile: "sim-balanced", expectedProfileMatched: false, selector: "modeldeck", fallback: false } }
  ]);
  assert.equal(summary.selectorExpectedRuns, 2);
  assert.equal(summary.selectorMatchedExpectedRuns, 1);
  assert.equal(summary.selectorExpectedMatchRate, 0.5);
  assert.equal(JSON.stringify(summary).includes("small-case"), false);
});

test("simulated execution fails safely when its patch cannot be applied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-simulation-test-"));
  const evaluationCase = manifest.cases[0];
  try {
    await writeFile(join(directory, "test-routing.test.ts"), "original", "utf8");
    if (!evaluationCase.simulation || "patches" in evaluationCase.simulation) throw new Error("This fixture requires a single simulation patch.");
    const simulation = { ...evaluationCase.simulation, file: "test-routing.test.ts", search: "missing" };
    assert.equal((await runSimulation(directory, simulation)).exitCode, 1);
    assert.equal(await readFile(join(directory, "test-routing.test.ts"), "utf8"), "original");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("simulated runs do not attribute allocations to Codex models", () => {
  assert.deepEqual(allocationsForRun(manifest, "single-model", "simulated"), {});
  assert.deepEqual(allocationsForRun(manifest, "fixed-roles", "simulated"), {});
  assert.deepEqual(allocationsForRun(manifest, "proxy-candidate", "slm-proxy"), {});
  assert.deepEqual(allocationsForRun(manifest, "single-model", "codex"), { singleModel: manifest.singleModel });
});

test("local proxy execution runs one distinct proxy-candidate strategy per iteration", () => {
  assert.deepEqual(strategiesForExecutionBackend("slm-proxy"), ["proxy-candidate"]);
  assert.deepEqual(strategiesForExecutionBackend("simulated"), ["single-model", "fixed-roles"]);
});

test("proxy cohorts require unchanged capability route identities", async () => {
  const routes = capabilityRouteIdsFor({ selector: "modeldeck", modelDeckModel: "selector", proxyModels: { "sim-small": "small", "sim-balanced": "balanced", "sim-strong": "strong" } });
  const snapshot = {
    selector: { publicModelId: "selector", localModelId: "local/selector", revision: "1", configurationFingerprint: "selector-config" },
    small: { publicModelId: "small", localModelId: "local/small", revision: "1", configurationFingerprint: "small-config" },
    balanced: { publicModelId: "balanced", localModelId: "local/balanced", revision: "1", configurationFingerprint: "balanced-config" },
    strong: { publicModelId: "strong", localModelId: "local/strong", revision: "1", configurationFingerprint: "strong-config" }
  };
  await assert.doesNotReject(assertCapabilitySnapshot({ snapshotRoutes: async () => snapshot }, routes, snapshot));
  await assert.rejects(assertCapabilitySnapshot({ snapshotRoutes: async () => ({ ...snapshot, strong: { ...snapshot.strong, configurationFingerprint: "replacement-config" } }) }, routes, snapshot), /routes changed/);
});

test("proxy readiness preflight targets declared expected tiers and otherwise all tiers", () => {
  const proxyModels = { "sim-small": "small", "sim-balanced": "balanced", "sim-strong": "strong" };
  assert.deepEqual(proxyModelsForReadiness([{ ...manifest.cases[0], expectedSimulationProfile: "sim-small" }], proxyModels), ["small"]);
  assert.deepEqual(proxyModelsForReadiness([{ ...manifest.cases[0], expectedSimulationProfile: undefined }], proxyModels), ["small", "balanced", "strong"]);
});

test("evaluation references are resolved to an immutable commit before worktrees are created", async () => {
  assert.match(await resolveEvaluationRef("HEAD"), /^[0-9a-f]{40}$/);
});

test("mutation checks restore the candidate worktree after evaluating it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-mutation-test-"));
  const evaluationCase = manifest.cases[0];
  try {
    await writeFile(join(directory, "src-routing.ts"), "original", "utf8");
    const mutation = { ...evaluationCase.mutation!, file: "src-routing.ts" };
    assert.equal(await runMutationCheck(directory, { ...evaluationCase, mutation }), true);
    assert.equal(await readFile(join(directory, "src-routing.ts"), "utf8"), "original");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mutation checks record a surviving mutation and restore the candidate worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-mutation-test-"));
  const evaluationCase = manifest.cases[0];
  try {
    await writeFile(join(directory, "src-routing.ts"), "original", "utf8");
    const mutation = { ...evaluationCase.mutation!, file: "src-routing.ts", validation: { command: process.execPath, args: ["-e", "process.exit(0)"] } };
    assert.equal(await runMutationCheck(directory, { ...evaluationCase, mutation }), false);
    assert.equal(await readFile(join(directory, "src-routing.ts"), "utf8"), "original");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
