import assert from "node:assert/strict";
import test from "node:test";
import { ModelDeckProvider, assertLoopbackUrl } from "../src/modelDeck";

test("ModelDeck provider rejects non-loopback endpoints", () => {
  assert.throws(() => assertLoopbackUrl("https://example.com/v1"), /loopback/);
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
