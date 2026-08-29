import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CodexAppServer, isChatGPTAuthentication } from "../src/appServer";
import { EvaluationCase, EvaluationManifest, EvaluationRunResult, EvaluationStrategy, buildPrompt, classifyCodexFailure, roleAgentFiles, summariseEvaluationRuns, validateAllocations, validateEvaluationManifest } from "../src/evaluation";

interface Options {
  live: boolean;
  manifestPath: string;
  resultsDirectory: string;
  ref: string;
  caseId?: string;
  iterations: number;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const manifest = await readManifest(options.manifestPath);
  const selectedCases = options.caseId ? manifest.cases.filter((evaluationCase) => evaluationCase.id === options.caseId) : manifest.cases;
  if (options.caseId && selectedCases.length === 0) throw new Error(`No evaluation case exists with ID ${options.caseId}.`);

  if (!options.live) {
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", cases: selectedCases.map((evaluationCase) => evaluationCase.id), strategies: ["single-model", "fixed-roles"], iterations: options.iterations, plannedRuns: selectedCases.length * 2 * options.iterations, message: "No Codex turn, validation command, worktree, or result file was created. Re-run with --live to consume Codex allowance." }, null, 2)}\n`);
    return;
  }

  const server = new CodexAppServer();
  try {
    const status = await server.start();
    if (!isChatGPTAuthentication(status.authMethod)) throw new Error("Live baseline evaluation requires existing ChatGPT authentication.");
    const allocationErrors = validateAllocations(manifest, status.models);
    if (allocationErrors.length > 0) throw new Error(`Live catalogue validation failed:\n${allocationErrors.join("\n")}`);
  } finally {
    server.dispose();
  }

  const runs: EvaluationRunResult[] = [];
  for (const evaluationCase of selectedCases) {
    for (let iteration = 1; iteration <= options.iterations; iteration++) {
      for (const strategy of ["single-model", "fixed-roles"] as const) {
        runs.push(await runEvaluation(manifest, evaluationCase, strategy, options.ref, iteration));
      }
    }
  }
  const report = { version: 1, generatedAt: new Date().toISOString(), ref: options.ref, runs, summary: summariseEvaluationRuns(runs) };
  await fs.mkdir(options.resultsDirectory, { recursive: true });
  const resultPath = join(options.resultsDirectory, `baseline-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ resultPath, summary: report.summary }, null, 2)}\n`);
}

async function runEvaluation(manifest: EvaluationManifest, evaluationCase: EvaluationCase, strategy: EvaluationStrategy, ref: string, iteration: number): Promise<EvaluationRunResult> {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-baseline-"));
  try {
    await run("git", ["worktree", "add", "--detach", directory, ref]);
    if (strategy === "fixed-roles") {
      const agentsDirectory = join(directory, ".codex", "agents");
      await fs.mkdir(agentsDirectory, { recursive: true });
      await Promise.all(Object.entries(roleAgentFiles(manifest.fixedRoles)).map(([name, content]) => fs.writeFile(join(agentsDirectory, name), content, { encoding: "utf8", mode: 0o600 })));
    }
    const allocation = strategy === "single-model" ? manifest.singleModel : manifest.fixedRoles.parent;
    const startedAt = Date.now();
    const codex = await runCodex(["exec", "--ephemeral", "-C", directory, "-m", allocation.model, "-c", `model_reasoning_effort=${JSON.stringify(allocation.effort)}`, "-s", "workspace-write", buildPrompt(strategy, evaluationCase)]);
    const codexExitCode = codex.exitCode;
    const validationExitCode = codexExitCode === 0 ? await runValidation(directory, evaluationCase) : null;
    const expectationPassed = codexExitCode === 0 ? await matchesExpectation(directory, evaluationCase) : null;
    const changedFiles = (await run("git", ["-C", directory, "diff", "--quiet"], { allowNonZero: true, suppressOutput: true })) !== 0;
    return {
      caseId: evaluationCase.id,
      iteration,
      strategy,
      allocations: strategy === "single-model" ? { singleModel: manifest.singleModel } : {
        parent: manifest.fixedRoles.parent,
        explorer: manifest.fixedRoles.explorer,
        worker: manifest.fixedRoles.worker,
        reviewer: manifest.fixedRoles.reviewer
      },
      durationMs: Date.now() - startedAt,
      codexExitCode,
      validationExitCode,
      expectationPassed,
      changedFiles,
      completedAt: new Date().toISOString(),
      failureKind: codexExitCode === 0 ? undefined : classifyCodexFailure(codex.stderr, codexExitCode)
    };
  } finally {
    await run("git", ["worktree", "remove", "--force", directory], { allowNonZero: true, suppressOutput: true });
  }
}

async function runValidation(directory: string, evaluationCase: EvaluationCase): Promise<number> {
  await linkInstalledDependencies(directory);
  return run(evaluationCase.validation.command, evaluationCase.validation.args, { cwd: directory, allowNonZero: true, suppressOutput: true });
}

export async function linkInstalledDependencies(directory: string): Promise<void> {
  const source = resolve("node_modules");
  let sourceStats;
  try {
    sourceStats = await fs.stat(source);
  } catch {
    throw new Error("Live baseline evaluation requires installed local dependencies in node_modules. Run npm install in the launch workspace first.");
  }
  if (!sourceStats.isDirectory()) throw new Error("Live baseline evaluation requires node_modules to be a directory.");
  await fs.symlink(source, join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}

async function matchesExpectation(directory: string, evaluationCase: EvaluationCase): Promise<boolean | null> {
  if (!evaluationCase.expectation) return null;
  const target = resolve(directory, evaluationCase.expectation.file);
  if (relative(directory, target).startsWith("..")) return false;
  const diff = await runCapture("git", ["-C", directory, "diff", "--", evaluationCase.expectation.file]);
  return evaluationCase.expectation.requiredPatterns.every((pattern) => diff.includes(pattern));
}

async function runCodex(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("codex", args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise({ exitCode: code ?? 1, stderr }));
  });
}

async function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited with status ${code ?? 1}.`)));
  });
}

async function readManifest(path: string): Promise<EvaluationManifest> {
  const content = await fs.readFile(path, "utf8");
  const value: unknown = JSON.parse(content);
  const errors = validateEvaluationManifest(value);
  if (errors.length > 0) throw new Error(`Invalid evaluation manifest:\n${errors.join("\n")}`);
  return value as EvaluationManifest;
}

async function run(command: string, args: string[], options: { cwd?: string; allowNonZero?: boolean; suppressOutput?: boolean } = {}): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: options.suppressOutput ? "ignore" : "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowNonZero) reject(new Error(`${command} exited with status ${exitCode}.`));
      else resolvePromise(exitCode);
    });
  });
}

function parseArguments(argumentsList: string[]): Options {
  const options: Options = { live: false, manifestPath: resolve("evals/baseline-manifest.json"), resultsDirectory: resolve("evals/results"), ref: "HEAD", iterations: 1 };
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (argument === "--live") options.live = true;
    else if (argument === "--manifest") options.manifestPath = resolve(requiredValue(argumentsList, ++index, argument));
    else if (argument === "--results-dir") options.resultsDirectory = resolve(requiredValue(argumentsList, ++index, argument));
    else if (argument === "--ref") options.ref = requiredValue(argumentsList, ++index, argument);
    else if (argument === "--case") options.caseId = requiredValue(argumentsList, ++index, argument);
    else if (argument === "--iterations") options.iterations = positiveInteger(requiredValue(argumentsList, ++index, argument), argument);
    else throw new Error(`Unknown argument: ${argument}.`);
  }
  return options;
}

function positiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${option} requires a positive integer.`);
  return Number(value);
}

function requiredValue(argumentsList: string[], index: number, option: string): string {
  const value = argumentsList[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown baseline evaluation failure.";
    process.stderr.write(`Baseline evaluation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
