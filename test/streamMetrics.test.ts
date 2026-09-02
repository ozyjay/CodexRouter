import assert from "node:assert/strict";
import test from "node:test";
import { StreamTokenEstimator } from "../src/streamMetrics";

test("stream token throughput is local and withheld until one second of output", () => {
  const estimator = new StreamTokenEstimator();
  assert.deepEqual(estimator.observe("abcd", 1_000), { estimatedTokens: 1, tokensPerSecond: undefined });
  assert.deepEqual(estimator.observe("efgh", 2_000), { estimatedTokens: 2, tokensPerSecond: 2 });
});
