import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OutcomeRecord } from "../src/contracts";
import { OutcomeStore, renderOutcomeMarkdown, summariseOutcomes } from "../src/outcomes";

function outcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    schemaVersion: 2,
    recordId: "record-1",
    timestamp: "2026-08-29T00:00:00.000Z",
    workspaceId: OutcomeStore.workspaceId(["/private/workspace"]),
    policyVersion: "deterministic-v1",
    taskType: "implementation",
    routingSource: "deterministic",
    recommendationStrength: "moderate",
    recommendation: { recommendedModel: "gpt-5.6-terra", recommendedEffort: "medium" },
    selected: { model: "gpt-5.6-terra", effort: "medium", overridden: false },
    durationMs: 1_000,
    turnState: "completed",
    taskOutcome: "unreported",
    validationStatus: "unreported",
    allocationJudgement: "unreported",
    ...overrides
  };
}

test("outcome records contain anonymous metadata and no task content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-test-"));
  try {
    const store = new OutcomeStore(directory);
    await store.append(outcome());
    const stored = await readFile(join(directory, "outcomes.ndjson"), "utf8");
    assert.doesNotMatch(stored, /private\/workspace/);
    assert.doesNotMatch(stored, /task text/i);
    assert.doesNotMatch(stored, /source excerpt/i);
    assert.doesNotMatch(stored, /filename/i);
    assert.match(stored, /workspaceId/);
    assert.deepEqual(await store.readAll(), [outcome()]);
    await store.clear();
    assert.deepEqual(await store.readAll(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("outcome summary requires explicit completion and passed validation", () => {
  const records = [
    outcome({ recordId: "verified", taskOutcome: "completed", validationStatus: "passed", allocationJudgement: "appropriate", repairTurns: 1 }),
    outcome({ recordId: "turn-only", taskOutcome: "unreported", validationStatus: "unreported", turnState: "completed", selected: { model: "gpt-5.6-terra", effort: "medium", overridden: true } }),
    outcome({ recordId: "cancelled", turnState: "cancelled", taskOutcome: "incomplete", validationStatus: "not-run", allocationJudgement: "under-powered" })
  ];
  const [summary] = summariseOutcomes(records);
  assert.equal(summary.sampleSize, 3);
  assert.equal(summary.verified, 1);
  assert.equal(summary.overrides, 1);
  assert.equal(summary.underPowered, 1);
  assert.equal(summary.elapsedMsPerVerifiedCompletion, 3_000);
  assert.equal(summary.smallSample, true);
  const report = renderOutcomeMarkdown(records);
  assert.match(report, /Small or incomplete sample/);
  assert.match(report, /descriptive local evidence, not a causal comparison/);
});

test("outcome store retains completed, failed and cancelled turn states without inferring task success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-states-"));
  try {
    const store = new OutcomeStore(directory);
    await store.append(outcome({ recordId: "completed", turnState: "completed" }));
    await store.append(outcome({ recordId: "failed", turnState: "failed" }));
    await store.append(outcome({ recordId: "cancelled", turnState: "cancelled" }));
    const records = await store.readAll();
    assert.deepEqual(records.map((record) => record.turnState), ["completed", "failed", "cancelled"]);
    assert.ok(records.every((record) => record.taskOutcome === "unreported"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("outcome reports separate proxy-assisted and unassisted Codex turns without storing the candidate", () => {
  const records = [
    outcome({ recordId: "without-proxy" }),
    outcome({ recordId: "with-proxy", localProxyModel: "codex-router-proxy-balanced" })
  ];
  const summaries = summariseOutcomes(records);
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries.map((summary) => summary.localProxyModel), [undefined, "codex-router-proxy-balanced"]);
  const report = renderOutcomeMarkdown(records);
  assert.match(report, /Proxy advisory/);
  assert.match(report, /codex-router-proxy-balanced/);
  assert.doesNotMatch(report, /search|replacement/i);
});
