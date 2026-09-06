import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoutingDiagnostics, diagnosticIdentifier } from "../src/routingDiagnostics";

test("ordinary diagnostics retain lifecycle and allocation metadata without sensitive content or files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-diagnostics-"));
  try {
    const output: string[] = [];
    const diagnostics = new RoutingDiagnostics(false, directory, (line) => output.push(line));
    diagnostics.sensitive("session.input", "private task");
    diagnostics.sensitive("classifier.response", "private response");
    diagnostics.delta("private generated text");
    diagnostics.record("routing.allocation-rejected", { reason: "effort-not-supported", requestedModel: "current", requestedEffort: "high", supportedEfforts: ["low"] });
    diagnostics.finish("failed");
    assert.doesNotMatch(output.join("\n"), /private/);
    assert.match(output.join("\n"), /effort-not-supported/);
    assert.match(output.join("\n"), /session.finished.*failed/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("opt-in sidebar diagnostics persist responses and final output with credential filtering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-diagnostics-"));
  try {
    const output: string[] = [];
    const diagnostics = new RoutingDiagnostics(true, directory, (line) => output.push(line));
    diagnostics.sensitive("classifier.response", { choices: [{ message: { content: "useful response" } }], access_token: "synthetic-secret" });
    diagnostics.delta("Bearer synthe");
    diagnostics.delta("tic-credential\nfinal text without newline");
    diagnostics.finish("completed");
    const [run] = await readdir(join(directory, "debug"));
    const text = await readFile(join(directory, "debug", run, "events.jsonl"), "utf8");
    assert.match(text, /useful response/);
    assert.match(text, /final text without newline/);
    assert.match(text, /session.finished.*completed/);
    assert.doesNotMatch(text, /synthetic-secret|synthetic-credential/);
    assert.doesNotMatch(output.join("\n"), /useful response|final text/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("diagnostic creation failures are visible without blocking a task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-diagnostics-"));
  try {
    const file = join(directory, "file");
    await writeFile(file, "existing");
    const output: string[] = [];
    const diagnostics = new RoutingDiagnostics(true, file, (line) => output.push(line));
    diagnostics.finish("completed");
    assert.match(output.join("\n"), /Unable to create the log/);
    assert.match(output.join("\n"), /session.finished/);
    assert.equal(diagnosticIdentifier("invented\nlog entry"), "[invalid identifier withheld]");
    assert.equal(diagnosticIdentifier("sk-syntheticcredential"), "[REDACTED TOKEN]");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
