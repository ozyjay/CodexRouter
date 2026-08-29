import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OutcomeStore } from "../src/outcomes";

test("outcome records contain anonymous metadata and no task content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-test-"));
  try {
    const store = new OutcomeStore(directory);
    await store.append({
      timestamp: "2026-08-29T00:00:00.000Z",
      workspaceId: OutcomeStore.workspaceId(["/private/workspace"]),
      taskType: "implementation",
      recommendation: { recommendedModel: "gpt-5.6-terra", recommendedEffort: "medium", confidence: 0.7, source: "deterministic-fallback" },
      selected: { model: "gpt-5.6-terra", effort: "medium", overridden: false }
    });
    const stored = await readFile(join(directory, "outcomes.ndjson"), "utf8");
    assert.doesNotMatch(stored, /private\/workspace/);
    assert.doesNotMatch(stored, /task text/i);
    assert.match(stored, /workspaceId/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
