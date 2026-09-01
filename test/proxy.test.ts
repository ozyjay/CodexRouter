import assert from "node:assert/strict";
import test from "node:test";
import { ProxyCandidateError } from "../src/modelDeck";
import { prepareSelectionProxyCandidate, renderProxyCandidateMarkdown } from "../src/proxy";

test("selected-code proxy candidates require one uniquely applicable patch", () => {
  const prepared = prepareSelectionProxyCandidate({
    model: { publicModelId: "codex-router-proxy-balanced" },
    patches: [{ file: "src/example.ts", search: "const oldValue = 1;", replacement: "const newValue = 2;" }]
  }, "src/example.ts", "before\nconst oldValue = 1;\nafter");
  assert.deepEqual(prepared, {
    model: "codex-router-proxy-balanced",
    file: "src/example.ts",
    search: "const oldValue = 1;",
    replacement: "const newValue = 2;"
  });
});

test("selected-code proxy candidates fail closed when search text is missing or ambiguous", () => {
  const candidate = {
    model: { publicModelId: "proxy" },
    patches: [{ file: "src/example.ts", search: "same", replacement: "changed" }]
  };
  for (const content of ["different", "same and same"]) {
    assert.throws(
      () => prepareSelectionProxyCandidate(candidate, "src/example.ts", content),
      (error: unknown) => error instanceof ProxyCandidateError && error.reason === "invalid-contract"
    );
  }
});

test("proxy preview is advisory and does not claim to edit the workspace", () => {
  const preview = renderProxyCandidateMarkdown({ model: "proxy", file: "src/example.ts", search: "old", replacement: "new" });
  assert.match(preview, /advisory candidate only/);
  assert.match(preview, /has not changed the workspace/);
  assert.match(preview, /Codex must review it independently/);
});
