import assert from "node:assert/strict";
import test from "node:test";
import { ModelDeckProvider, ProxyCandidateError, assertLoopbackUrl, assertModelDeckModelId, classifyModelDeckFailure } from "../src/modelDeck";

test("ModelDeck provider rejects non-loopback endpoints", () => {
  assert.throws(() => assertLoopbackUrl("https://example.com/v1"), /loopback/);
});

test("ModelDeck model IDs reject control characters", () => {
  assert.doesNotThrow(() => assertModelDeckModelId("codex-router-proxy-balanced"));
  assert.throws(() => assertModelDeckModelId("proxy\nspoofed"), /model ID/);
});

test("ModelDeck route snapshots retain only configured safe identities", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [
    { id: "selector", ready: true, revision: "selector-revision", modeldeck: { model_id: "local/selector", configuration_fingerprint: "selector-config" } },
    { id: "proxy", ready: false, revision: "proxy-revision", modeldeck: { model_id: "local/proxy", configuration_fingerprint: "proxy-config" } }
  ] }), { status: 200 })) as typeof fetch;
  try {
    const provider = new ModelDeckProvider({ baseUrl: "http://127.0.0.1:8600/v1", timeoutMs: 1_000 });
    assert.deepEqual(await provider.snapshotRoutes(["selector", "proxy"]), {
      selector: { publicModelId: "selector", localModelId: "local/selector", revision: "selector-revision", configurationFingerprint: "selector-config" },
      proxy: { publicModelId: "proxy", localModelId: "local/proxy", revision: "proxy-revision", configurationFingerprint: "proxy-config" }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelDeck readiness preflight waits for consecutive ready catalogue states", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount++;
    return new Response(JSON.stringify({ data: [{ id: "proxy", ready: requestCount > 1 }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new ModelDeckProvider({ baseUrl: "http://127.0.0.1:8600/v1", timeoutMs: 1_000 });
    const readiness = await provider.waitForReadyModels(["proxy"], { timeoutMs: 1_000, pollIntervalMs: 1, consecutiveReadyChecks: 2 }, async () => undefined);
    assert.deepEqual(readiness.modelIds, ["proxy"]);
    assert.equal(readiness.consecutiveReadyChecks, 2);
    assert.equal(requestCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelDeck malformed responses are rejected", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: "local-router", ready: true }] }), { status: 200 })) as typeof fetch;
  try {
    const provider = new ModelDeckProvider({ baseUrl: "http://127.0.0.1:8600/v1", timeoutMs: 1_000 });
    await assert.rejects(provider.classify({ task: "Add a test." }), /no chat-completion content/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelDeck classifier receives metadata but never execution source", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let requestBody = "";
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requestCount++;
    if (requestCount === 2 && typeof init?.body === "string") requestBody = init.body;
    return new Response(JSON.stringify(requestCount === 1
      ? { data: [{ id: "local-router", ready: true, revision: "revision-1" }] }
      : { choices: [{ message: { content: "{\"taskType\":\"testing\",\"scope\":\"narrow\",\"complexity\":\"low\",\"risk\":\"normal\",\"ambiguity\":\"low\",\"recommendedModel\":\"gpt-5.6-luna\",\"recommendedEffort\":\"low\",\"confidence\":0.8,\"reasons\":[\"Bounded test change.\"],\"escalationSignals\":[]}" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new ModelDeckProvider({ baseUrl: "http://127.0.0.1:8600/v1", timeoutMs: 1_000 });
    const recommendation = await provider.classify({ task: "Add one test.", metadata: { languageId: "typescript", selectionPresent: true, selectedCharacters: 42 } });
    assert.equal(recommendation.classifierModel, "local-router");
    assert.equal(recommendation.source, "local-model");
    assert.match(requestBody, /selectedCharacters/);
    assert.doesNotMatch(requestBody, /secret source excerpt/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelDeck unavailable, no-ready-model and timeout failures are classified safely", async () => {
  assert.equal(classifyModelDeckFailure(new Error("connection refused")), "unavailable");
  assert.equal(classifyModelDeckFailure(new Error("ModelDeck did not report a ready local routing model.")), "no-ready-model");
  assert.equal(classifyModelDeckFailure(new Error("ModelDeck request timed out.")), "timeout");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch;
  try {
    const provider = new ModelDeckProvider({ baseUrl: "http://127.0.0.1:8600/v1", timeoutMs: 5 });
    await assert.rejects(provider.classify({ task: "Add one test." }), /timed out/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelDeck simulation selector returns only its bounded contract and model identity", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount++;
    if (requestCount === 1) {
      return new Response(JSON.stringify({ data: [{ id: "codex-router-simulation-selector", ready: true, revision: "abc", modeldeck: { model_id: "local/selector" } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"simulationProfile\":\"sim-small\",\"confidence\":0.82,\"rationale\":\"Focused test change.\"}" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new ModelDeckProvider({ baseUrl: "http://127.0.0.1:8600/v1", routerModel: "codex-router-simulation-selector", timeoutMs: 1_000 });
    const recommendation = await provider.selectSimulationProfile({ task: "Add one test.", taskCategory: "testing", estimatedFilesAffected: 1, testsRequested: true, riskFlags: [] });
    assert.deepEqual(recommendation, { simulationProfile: "sim-small", confidence: 0.82, rationale: "Focused test change.", model: { publicModelId: "codex-router-simulation-selector", localModelId: "local/selector", revision: "abc" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelDeck simulation selector rejects unbounded output", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount++;
    return new Response(JSON.stringify(requestCount === 1
      ? { data: [{ id: "codex-router-simulation-selector", ready: true }] }
      : { choices: [{ message: { content: "{\"simulationProfile\":\"sim-small\",\"confidence\":0.8,\"rationale\":\"Fine.\",\"patch\":\"forbidden\"}" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new ModelDeckProvider({ baseUrl: "http://127.0.0.1:8600/v1", routerModel: "codex-router-simulation-selector", timeoutMs: 1_000 });
    await assert.rejects(provider.selectSimulationProfile({ task: "Add one test.", taskCategory: "testing", estimatedFilesAffected: 1, testsRequested: true, riskFlags: [] }), /invalid simulation-selector/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelDeck proxy candidates are restricted to declared contextual files and patches", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let completionBody: { max_tokens?: number } | undefined;
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requestCount++;
    if (requestCount === 2 && typeof init?.body === "string") completionBody = JSON.parse(init.body) as { max_tokens?: number };
    return new Response(JSON.stringify(requestCount === 1
      ? { data: [{ id: "codex-router-proxy-strong", ready: true, revision: "proxy-revision", modeldeck: { model_id: "local/proxy" } }] }
      : { choices: [{ message: { content: "<think>Choose the supplied test file.</think>\n{\"patches\":[{\"file\":\"test/routing.test.ts\",\"search\":\"original\",\"replacement\":\"updated\"}]}" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new ModelDeckProvider({ baseUrl: "http://127.0.0.1:8600/v1", timeoutMs: 1_000 });
    const candidate = await provider.generateProxyCandidate("codex-router-proxy-strong", {
      task: "Update one test.",
      allowedFiles: ["test/routing.test.ts", "src/routing.ts"],
      context: [{ file: "test/routing.test.ts", content: "original" }],
      maxPatches: 1
    }, 256);
    assert.deepEqual(candidate, {
      patches: [{ file: "test/routing.test.ts", search: "original", replacement: "updated" }],
      model: { publicModelId: "codex-router-proxy-strong", localModelId: "local/proxy", revision: "proxy-revision" }
    });
    assert.equal(completionBody?.max_tokens, 256);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelDeck proxy candidates reject edits outside supplied context", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount++;
    return new Response(JSON.stringify(requestCount === 1
      ? { data: [{ id: "codex-router-proxy-strong", ready: true }] }
      : { choices: [{ message: { content: "{\"patches\":[{\"file\":\"src/routing.ts\",\"search\":\"original\",\"replacement\":\"updated\"}]}" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new ModelDeckProvider({ baseUrl: "http://127.0.0.1:8600/v1", timeoutMs: 1_000 });
    await assert.rejects(provider.generateProxyCandidate("codex-router-proxy-strong", {
      task: "Update one test.",
      allowedFiles: ["test/routing.test.ts", "src/routing.ts"],
      context: [{ file: "test/routing.test.ts", content: "original" }],
      maxPatches: 1
    }), (error: unknown) => error instanceof ProxyCandidateError && error.reason === "invalid-contract");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
