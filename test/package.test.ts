import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("extension configuration keeps deterministic routing and analytics-safe defaults", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as { contributes: { configuration: { properties: Record<string, { default?: unknown }> } } };
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties["codexRouter.routing.provider"].default, "deterministic");
  assert.equal(properties["codexRouter.analytics.enabled"].default, false);
});
