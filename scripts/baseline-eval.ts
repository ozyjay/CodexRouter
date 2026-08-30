import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CodexAppServer, isChatGPTAuthentication } from "../src/appServer";
import { ModelDeckProvider, SimulationSelectorRecommendation } from "../src/modelDeck";
import { EvaluationCase, EvaluationExecutionBackend, EvaluationManifest, EvaluationRunResult, EvaluationStrategy, SimulationPatch, SimulationProfile, SimulationRunMetadata, buildPrompt, classifyCodexFailure, roleAgentFiles, simulationPatchForProfile, summariseEvaluationRuns, validateAllocations, validateEvaluationManifest } from "../src/evaluation";

type SimulationSelectorKind = "deterministic" | "modeldeck";

interface SimulationSelector {
  selectSimulationProfile(input: { task: string; taskCategory: string; estimatedFilesAffected: number; testsRequested: boolean; riskFlags: string[] }): Promise<SimulationSelectorRecommendation>;
}

interface ResolvedSimulation {
  patch?: SimulationPatch;
  metadata: SimulationRunMetadata;
}

interface Options {
  live: boolean;
  simulated: boolean;
  manifestPath: string;
  resultsDirectory: string;
  ref: string;
  caseId?: string;
  iterations: number;
  selector: SimulationSelectorKind;
  modelDeckBaseUrl: string;
  modelDeckModel: string;
  selectorTimeoutMs: number;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const manifest = await readManifest(options.manifestPath);
  const selectedCases = options.caseId ? manifest.cases.filter((evaluationCase) => evaluationCase.id === options.caseId) : manifest.cases;
  if (options.caseId && selectedCases.length === 0) throw new Error(`No evaluation case exists with ID ${options.caseId}.`);
  if (options.live && options.simulated) throw new Error("Choose either --live or --simulated, not both.");
  if (options.selector === "modeldeck" && !options.simulated && (options.live || options.simulated)) throw new Error("--selector modeldeck is available only with --simulated.");

  if (!options.live && !options.simulated) {
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", cases: selectedCases.map((evaluationCase) => evaluationCase.id), strategies: ["single-model", "fixed-roles"], iterations: options.iterations, plannedRuns: selectedCases.length * 2 * options.iterations, simulationSelector: options.selector === "modeldeck" ? { kind: options.selector, model: options.modelDeckModel } : { kind: options.selector }, message: "No Codex turn, ModelDeck request, validation command, worktree, or result file was created. Re-run with --simulated for an offline worktree evaluation or --live to consume Codex allowance." }, null, 2)}\n`);
    return;
  }

  if (options.live) {
    const server = new CodexAppServer();
    try {
      const status = await server.start();
      if (!isChatGPTAuthentication(status.authMethod)) throw new Error("Live baseline evaluation requires existing ChatGPT authentication.");
      const allocationErrors = validateAllocations(manifest, status.models);
      if (allocationErrors.length > 0) throw new Error(`Live catalogue validation failed:\n${allocationErrors.join("\n")}`);
    } finally {
      server.dispose();
    }
  }

  const executionBackend: EvaluationExecutionBackend = options.simulated ? "simulated" : "codex";
  const selector = executionBackend === "simulated" && options.selector === "modeldeck"
    ? new ModelDeckProvider({ baseUrl: options.modelDeckBaseUrl, routerModel: options.modelDeckModel, timeoutMs: options.selectorTimeoutMs })
    : undefined;
  const runs: EvaluationRunResult[] = [];
  for (const evaluationCase of selectedCases) {
    for (let iteration = 1; iteration <= options.iterations; iteration++) {
      for (const strategy of ["single-model", "fixed-roles"] as const) {
        runs.push(await runEvaluation(manifest, evaluationCase, strategy, options.ref, iteration, executionBackend, options.selector, selector));
      }
    }
  }
  const report = {
    version: 3,
    generatedAt: new Date().toISOString(),
    ref: options.ref,
    executionBackend,
    simulation: executionBackend === "simulated" ? {
      purpose: "Validate evaluation-harness isolation, quality gates, reporting, and failure accounting without a Codex turn.",
      allocationAttribution: "none",
      performanceAttribution: "none",
      selector: options.selector === "modeldeck" ? { kind: "modeldeck", publicModelId: options.modelDeckModel } : { kind: "deterministic" }
    } : undefined,
    runs,
    summary: summariseEvaluationRuns(runs)
  };
  await fs.mkdir(options.resultsDirectory, { recursive: true });
  const resultPath = join(options.resultsDirectory, `baseline-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ resultPath, executionBackend, summary: report.summary }, null, 2)}\n`);
}

async function runEvaluation(manifest: EvaluationManifest, evaluationCase: EvaluationCase, strategy: EvaluationStrategy, ref: string, iteration: number, executionBackend: EvaluationExecutionBackend, selectorKind: SimulationSelectorKind, selector?: SimulationSelector): Promise<EvaluationRunResult> {
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
    const simulation = executionBackend === "simulated" ? await resolveSimulation(evaluationCase, selectorKind, selector) : undefined;
    const execution = executionBackend === "codex"
      ? await runCodex(["exec", "--ephemeral", "-C", directory, "-m", allocation.model, "-c", `model_reasoning_effort=${JSON.stringify(allocation.effort)}`, "-s", "workspace-write", buildPrompt(strategy, evaluationCase)])
      : await runSimulation(directory, simulation?.patch);
    const executionExitCode = execution.exitCode;
    const validationExitCode = executionExitCode === 0 ? await runValidation(directory, evaluationCase) : null;
    const expectationPassed = executionExitCode === 0 ? await matchesExpectation(directory, evaluationCase) : null;
    const changedFiles = (await run("git", ["-C", directory, "diff", "--quiet"], { allowNonZero: true, suppressOutput: true })) !== 0;
    const mutationKilled = executionExitCode === 0 && validationExitCode === 0 && expectationPassed !== false ? await runMutationCheck(directory, evaluationCase) : null;
    return {
      caseId: evaluationCase.id,
      iteration,
      strategy,
      executionBackend,
      allocations: allocationsForRun(manifest, strategy, executionBackend),
      durationMs: Date.now() - startedAt,
      executionExitCode,
      validationExitCode,
      expectationPassed,
      mutationKilled,
      changedFiles,
      completedAt: new Date().toISOString(),
      failureKind: executionExitCode === 0 ? undefined : executionBackend === "simulated" ? "simulation" : classifyCodexFailure(execution.stderr, executionExitCode),
      simulation: simulation?.metadata
    };
  } finally {
    await run("git", ["worktree", "remove", "--force", directory], { allowNonZero: true, suppressOutput: true });
  }
}

async function resolveSimulation(evaluationCase: EvaluationCase, selectorKind: SimulationSelectorKind, selector?: SimulationSelector): Promise<ResolvedSimulation> {
  if (!selector || selectorKind === "deterministic") return resolvedSimulation(evaluationCase, "sim-balanced", "deterministic", false);
  const startedAt = Date.now();
  try {
    const recommendation = await selector.selectSimulationProfile({
      task: evaluationCase.prompt,
      taskCategory: taskCategory(evaluationCase),
      estimatedFilesAffected: evaluationCase.expectation ? 1 : 2,
      testsRequested: /\b(test|validation|assert)\b/i.test(evaluationCase.prompt),
      riskFlags: riskFlags(evaluationCase.prompt)
    });
    const resolved = resolvedSimulation(evaluationCase, recommendation.simulationProfile, "modeldeck", false);
    return {
      ...resolved,
      metadata: {
        ...resolved.metadata,
        selectorDurationMs: Date.now() - startedAt,
        selectorModel: recommendation.model
      }
    };
  } catch {
    const resolved = resolvedSimulation(evaluationCase, "sim-balanced", "modeldeck", true);
    return {
      ...resolved,
      metadata: { ...resolved.metadata, selectorDurationMs: Date.now() - startedAt }
    };
  }
}

function resolvedSimulation(evaluationCase: EvaluationCase, selectedProfile: SimulationProfile, selector: SimulationSelectorKind, fallback: boolean): ResolvedSimulation {
  const selected = simulationPatchForProfile(evaluationCase, selectedProfile);
  return {
    patch: selected.patch,
    metadata: { selectedProfile, appliedProfile: selected.profile, selector, fallback: fallback || selected.profile !== selectedProfile }
  };
}

function taskCategory(evaluationCase: EvaluationCase): string {
  if (/\b(test|assert|regression)\b/i.test(evaluationCase.prompt)) return "testing";
  if (/\b(debug|fix|bug|error)\b/i.test(evaluationCase.prompt)) return "debugging";
  return "implementation";
}

function riskFlags(task: string): string[] {
  const flags: string[] = [];
  if (/\b(delete|drop|destroy|remove database)\b/i.test(task)) flags.push("destructive");
  if (/\b(security|auth|credential|permission|secret)\b/i.test(task)) flags.push("security-sensitive");
  return flags;
}

export function allocationsForRun(manifest: EvaluationManifest, strategy: EvaluationStrategy, executionBackend: EvaluationExecutionBackend): Record<string, { model: string; effort: string }> {
  if (executionBackend === "simulated") return {};
  return strategy === "single-model" ? { singleModel: manifest.singleModel } : {
    parent: manifest.fixedRoles.parent,
    explorer: manifest.fixedRoles.explorer,
    worker: manifest.fixedRoles.worker,
    reviewer: manifest.fixedRoles.reviewer
  };
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
    throw new Error("Baseline evaluation requires installed local dependencies in node_modules. Run npm install in the launch workspace first.");
  }
  if (!sourceStats.isDirectory()) throw new Error("Baseline evaluation requires node_modules to be a directory.");
  await fs.symlink(source, join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}

async function matchesExpectation(directory: string, evaluationCase: EvaluationCase): Promise<boolean | null> {
  if (!evaluationCase.expectation) return null;
  const target = resolve(directory, evaluationCase.expectation.file);
  if (relative(directory, target).startsWith("..")) return false;
  const diff = await runCapture("git", ["-C", directory, "diff", "--", evaluationCase.expectation.file]);
  return evaluationCase.expectation.requiredPatterns.every((pattern) => diff.includes(pattern));
}

export async function runMutationCheck(directory: string, evaluationCase: EvaluationCase): Promise<boolean | null> {
  if (!evaluationCase.mutation) return null;
  const target = resolve(directory, evaluationCase.mutation.file);
  if (relative(directory, target).startsWith("..")) return false;
  let original: string;
  try {
    original = await fs.readFile(target, "utf8");
  } catch {
    return false;
  }
  if (!original.includes(evaluationCase.mutation.search)) return false;
  const mutated = original.replace(evaluationCase.mutation.search, evaluationCase.mutation.replacement);
  try {
    await fs.writeFile(target, mutated, "utf8");
    return (await run(evaluationCase.mutation.validation.command, evaluationCase.mutation.validation.args, { cwd: directory, allowNonZero: true, suppressOutput: true })) !== 0;
  } finally {
    await fs.writeFile(target, original, "utf8");
  }
}

export async function runSimulation(directory: string, patch?: SimulationPatch): Promise<{ exitCode: number; stderr: string }> {
  if (!patch) return { exitCode: 1, stderr: "" };
  const target = resolve(directory, patch.file);
  if (relative(directory, target).startsWith("..")) return { exitCode: 1, stderr: "" };
  let original: string;
  try {
    original = await fs.readFile(target, "utf8");
  } catch {
    return { exitCode: 1, stderr: "" };
  }
  if (!original.includes(patch.search)) return { exitCode: 1, stderr: "" };
  await fs.writeFile(target, original.replace(patch.search, patch.replacement), "utf8");
  return { exitCode: 0, stderr: "" };
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
  const options: Options = { live: false, simulated: false, manifestPath: resolve("evals/baseline-manifest.json"), resultsDirectory: resolve("evals/results"), ref: "HEAD", iterations: 1, selector: "deterministic", modelDeckBaseUrl: "http://127.0.0.1:8600/v1", modelDeckModel: "codex-router-simulation-selector", selectorTimeoutMs: 15_000 };
  for (let index = 0; index < argumentsList.length; index++) {
    const argument = argumentsList[index];
    if (argument === "--live") options.live = true;
    else if (argument === "--simulated") options.simulated = true;
    else if (argument === "--manifest") options.manifestPath = resolve(requiredValue(argumentsList, ++index, argument));
    else if (argument === "--results-dir") options.resultsDirectory = resolve(requiredValue(argumentsList, ++index, argument));
    else if (argument === "--ref") options.ref = requiredValue(argumentsList, ++index, argument);
    else if (argument === "--case") options.caseId = requiredValue(argumentsList, ++index, argument);
    else if (argument === "--iterations") options.iterations = positiveInteger(requiredValue(argumentsList, ++index, argument), argument);
    else if (argument === "--selector") options.selector = simulationSelectorKind(requiredValue(argumentsList, ++index, argument));
    else if (argument === "--modeldeck-base-url") options.modelDeckBaseUrl = requiredValue(argumentsList, ++index, argument);
    else if (argument === "--modeldeck-model") options.modelDeckModel = requiredValue(argumentsList, ++index, argument);
    else if (argument === "--selector-timeout-ms") options.selectorTimeoutMs = positiveInteger(requiredValue(argumentsList, ++index, argument), argument);
    else throw new Error(`Unknown argument: ${argument}.`);
  }
  return options;
}

function simulationSelectorKind(value: string): SimulationSelectorKind {
  if (value === "deterministic" || value === "modeldeck") return value;
  throw new Error("--selector must be deterministic or modeldeck.");
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
