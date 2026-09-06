import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { EvaluationDebugLog, debugLineSink, runDebugCommand } from "../scripts/evaluation-debug";
import { parseArguments, runMutationCheck } from "../scripts/baseline-eval";
import { writeFile } from "node:fs/promises";

test("debug logging requires an explicit flag", () => {
  assert.equal(parseArguments(["--live"]).debugLogs, undefined);
  assert.equal(parseArguments(["--live", "--debug-logs"]).debugLogs, true);
  assert.equal(parseArguments(["--slm-proxy", "--debug-logs"]).debugLogs, true);
});

test("development logs redact structured and streamed credentials and use private files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-debug-test-"));
  try {
    const log = new EvaluationDebugLog(directory);
    log.write("response", { access_token: "synthetic-secret", content: JSON.stringify({ password: "synthetic-password", answer: "useful answer" }) });
    const lines = debugLineSink((line) => log.write("stdout", line));
    lines.push("Authorisation: Bear");
    lines.push("er synthetic-credential\nordinary output\n-----BEGIN PRIVATE KEY-----\n");
    lines.push("synthetic-private-material\n-----END PRIVATE KEY-----\nlast line");
    lines.finish();
    const content = await readFile(log.path, "utf8");
    for (const secret of ["synthetic-secret", "synthetic-password", "synthetic-credential", "synthetic-private-material"]) assert.equal(content.includes(secret), false);
    assert.match(content, /useful answer/);
    assert.match(content, /ordinary output/);
    assert.match(content, /last line/);
    content.trim().split("\n").forEach((line) => JSON.parse(line));
    if (process.platform !== "win32") {
      assert.equal((await stat(log.path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(log.path))).mode & 0o777, 0o700);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("oversized lines are withheld and subsequent output is retained", () => {
  const output: string[] = [];
  const lines = debugLineSink((line) => output.push(line));
  lines.push("x".repeat(65_537));
  lines.push("secret tail\nnext line\n");
  lines.finish();
  assert.deepEqual(output, ["[Oversized debug line withheld]", "next line\n"]);
});

test("failed commands retain both streams including final output before close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-debug-command-"));
  try {
    const log = new EvaluationDebugLog(directory);
    const result = await runDebugCommand(process.execPath, ["-e", "process.stdout.write('useful stdout'); process.stderr.write('useful stderr'); process.exitCode = 7"], log, "validation");
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, "useful stderr");
    const events = (await readFile(log.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "validation.stdout" && event.detail === "useful stdout"));
    assert.ok(events.some((event) => event.event === "validation.stderr" && event.detail === "useful stderr"));
    assert.equal(events.at(-1).detail.exitCode, 7);
    await assert.rejects(runDebugCommand(join(directory, "missing-command"), [], log, "missing"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("inapplicable mutations have an explicit debug reason", async () => {
  const directory = await mkdtemp(join(tmpdir(), "router-debug-mutation-"));
  try {
    const log = new EvaluationDebugLog(directory);
    await writeFile(join(directory, "source.ts"), "current source");
    const result = await runMutationCheck(directory, {
      id: "mutation", prompt: "test", validation: { command: "unused", args: [] },
      mutation: { file: "source.ts", search: "stale source", replacement: "mutant", validation: { command: "must-not-run", args: [] } }
    }, log);
    assert.equal(result, false);
    assert.match(await readFile(log.path, "utf8"), /search-not-found/);
    assert.equal(await readFile(join(directory, "source.ts"), "utf8"), "current source");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
