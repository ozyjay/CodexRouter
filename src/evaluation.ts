import { CodexModel, ReasoningEffort } from "./contracts";

export type EvaluationStrategy = "single-model" | "fixed-roles";
export type EvaluationFailureKind = "authentication" | "cli-configuration" | "model-allocation" | "worktree" | "startup-or-runtime";

export interface Allocation {
  model: string;
  effort: ReasoningEffort;
}

export interface FixedRoleAllocations {
  parent: Allocation;
  explorer: Allocation;
  worker: Allocation;
  reviewer: Allocation;
}

export interface ValidationCommand {
  command: string;
  args: string[];
}

export interface DiffExpectation {
  file: string;
  requiredPatterns: string[];
}

export interface EvaluationCase {
  id: string;
  prompt: string;
  validation: ValidationCommand;
  expectation?: DiffExpectation;
}

export interface EvaluationManifest {
  version: 1;
  singleModel: Allocation;
  fixedRoles: FixedRoleAllocations;
  cases: EvaluationCase[];
}

export interface EvaluationRunResult {
  caseId: string;
  iteration: number;
  strategy: EvaluationStrategy;
  allocations: Record<string, Allocation>;
  durationMs: number;
  codexExitCode: number | null;
  validationExitCode: number | null;
  expectationPassed: boolean | null;
  changedFiles: boolean;
  completedAt: string;
  failureKind?: EvaluationFailureKind;
}

export interface EvaluationSummary {
  totalRuns: number;
  completedRuns: number;
  validationPassedRuns: number;
  expectationPassedRuns: number;
  verifiedRuns: number;
  changedRuns: number;
  averageDurationMs: number;
  byStrategy: Record<EvaluationStrategy, { total: number; validationPassed: number; expectationPassed: number; verified: number; averageDurationMs: number }>;
}

export function validateEvaluationManifest(value: unknown): string[] {
  if (!isRecord(value)) return ["Manifest must be an object."];
  const errors: string[] = [];
  if (value.version !== 1) errors.push("Manifest version must be 1.");
  if (!isAllocation(value.singleModel)) errors.push("singleModel must include a model and effort.");
  if (!isRecord(value.fixedRoles) || !isAllocation(value.fixedRoles.parent) || !isAllocation(value.fixedRoles.explorer) || !isAllocation(value.fixedRoles.worker) || !isAllocation(value.fixedRoles.reviewer)) {
    errors.push("fixedRoles must include parent, explorer, worker, and reviewer allocations.");
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    errors.push("cases must contain at least one evaluation case.");
    return errors;
  }
  const ids = new Set<string>();
  for (const [index, candidate] of value.cases.entries()) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(candidate.id)) {
      errors.push(`cases[${index}] must have a lower-case kebab-case ID.`);
      continue;
    }
    if (ids.has(candidate.id)) errors.push(`Evaluation case ID is duplicated: ${candidate.id}.`);
    ids.add(candidate.id);
    if (typeof candidate.prompt !== "string" || candidate.prompt.trim().length === 0) errors.push(`cases[${index}] must have a task prompt.`);
    if (!isValidationCommand(candidate.validation)) errors.push(`cases[${index}] must have an executable validation command and argument array.`);
    if (candidate.expectation !== undefined && !isDiffExpectation(candidate.expectation)) errors.push(`cases[${index}] expectation must name a relative file and at least one required pattern.`);
  }
  return errors;
}

export function validateAllocations(manifest: EvaluationManifest, models: readonly CodexModel[]): string[] {
  const errors: string[] = [];
  for (const [role, allocation] of Object.entries(allAllocations(manifest))) {
    const model = models.find((candidate) => candidate.id === allocation.model || candidate.model === allocation.model);
    if (!model) {
      errors.push(`${role} selects unavailable model ${allocation.model}.`);
      continue;
    }
    if (!model.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === allocation.effort)) {
      errors.push(`${role} selects unsupported effort ${allocation.effort} for ${allocation.model}.`);
    }
  }
  return errors;
}

export function buildPrompt(strategy: EvaluationStrategy, evaluationCase: EvaluationCase): string {
  const task = evaluationCase.prompt.trim();
  if (strategy === "single-model") return `${task}\n\nRun the specified validation command before finishing. Keep the change focused and report only a concise completion summary.`;
  return `Complete this task through the fixed baseline roles, sequentially and without parallel delegation:\n1. Ask router_baseline_explorer to map the relevant code path, risks, and validation approach.\n2. Ask router_baseline_worker to make the smallest defensible implementation using that evidence.\n3. Ask router_baseline_reviewer to inspect the resulting diff for correctness, security, regressions, and missing tests.\n4. Repair only concrete reviewer findings, then run the specified validation command.\n\nTask:\n${task}`;
}

export function roleAgentFiles(roles: FixedRoleAllocations): Record<string, string> {
  return {
    "router-baseline-explorer.toml": renderAgent("router_baseline_explorer", "Read-only explorer for the fixed routing baseline.", roles.explorer, "read-only", "Map the relevant execution path, files, symbols, risks, and focused validation. Do not edit files."),
    "router-baseline-worker.toml": renderAgent("router_baseline_worker", "Implementation worker for the fixed routing baseline.", roles.worker, "workspace-write", "Implement the smallest defensible change using the explorer's evidence. Keep unrelated files untouched and run focused validation."),
    "router-baseline-reviewer.toml": renderAgent("router_baseline_reviewer", "Read-only reviewer for the fixed routing baseline.", roles.reviewer, "read-only", "Review the resulting diff for correctness, security, behaviour regressions, and missing tests. Report concrete findings only. Do not edit files.")
  };
}

export function summariseEvaluationRuns(runs: readonly EvaluationRunResult[]): EvaluationSummary {
  const byStrategy: EvaluationSummary["byStrategy"] = {
    "single-model": { total: 0, validationPassed: 0, expectationPassed: 0, verified: 0, averageDurationMs: 0 },
    "fixed-roles": { total: 0, validationPassed: 0, expectationPassed: 0, verified: 0, averageDurationMs: 0 }
  };
  let durationTotal = 0;
  let completedRuns = 0;
  let validationPassedRuns = 0;
  let expectationPassedRuns = 0;
  let verifiedRuns = 0;
  let changedRuns = 0;
  for (const run of runs) {
    const bucket = byStrategy[run.strategy];
    bucket.total++;
    bucket.averageDurationMs += run.durationMs;
    durationTotal += run.durationMs;
    if (run.codexExitCode === 0) completedRuns++;
    if (run.validationExitCode === 0) {
      validationPassedRuns++;
      bucket.validationPassed++;
    }
    if (run.expectationPassed === true) {
      expectationPassedRuns++;
      bucket.expectationPassed++;
    }
    if (run.validationExitCode === 0 && run.expectationPassed !== false) {
      verifiedRuns++;
      bucket.verified++;
    }
    if (run.changedFiles) changedRuns++;
  }
  for (const bucket of Object.values(byStrategy)) {
    bucket.averageDurationMs = bucket.total === 0 ? 0 : Math.round(bucket.averageDurationMs / bucket.total);
  }
  return {
    totalRuns: runs.length,
    completedRuns,
    validationPassedRuns,
    expectationPassedRuns,
    verifiedRuns,
    changedRuns,
    averageDurationMs: runs.length === 0 ? 0 : Math.round(durationTotal / runs.length),
    byStrategy
  };
}

export function classifyCodexFailure(stderr: string, exitCode: number): EvaluationFailureKind {
  const value = stderr.toLowerCase();
  if (/auth|log\s*in|sign\s*in/.test(value)) return "authentication";
  if (/unknown argument|unexpected argument|invalid value|config(uration)?/.test(value) || exitCode === 2) return "cli-configuration";
  if (/model.*(unavailable|unsupported|not found)|unsupported.*model/.test(value)) return "model-allocation";
  if (/worktree|git repository|not a repository/.test(value)) return "worktree";
  return "startup-or-runtime";
}

function allAllocations(manifest: EvaluationManifest): Record<string, Allocation> {
  return {
    singleModel: manifest.singleModel,
    parent: manifest.fixedRoles.parent,
    explorer: manifest.fixedRoles.explorer,
    worker: manifest.fixedRoles.worker,
    reviewer: manifest.fixedRoles.reviewer
  };
}

function renderAgent(name: string, description: string, allocation: Allocation, sandboxMode: "read-only" | "workspace-write", instructions: string): string {
  return `name = "${name}"\ndescription = "${description}"\nmodel = "${allocation.model}"\nmodel_reasoning_effort = "${allocation.effort}"\nsandbox_mode = "${sandboxMode}"\ndeveloper_instructions = """\n${instructions}\n"""\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllocation(value: unknown): value is Allocation {
  return isRecord(value) && typeof value.model === "string" && value.model.length > 0 && typeof value.effort === "string" && value.effort.length > 0;
}

function isValidationCommand(value: unknown): value is ValidationCommand {
  return isRecord(value) && typeof value.command === "string" && value.command.length > 0 && Array.isArray(value.args) && value.args.every((argument) => typeof argument === "string");
}

function isDiffExpectation(value: unknown): value is DiffExpectation {
  return isRecord(value)
    && typeof value.file === "string"
    && value.file.length > 0
    && !value.file.startsWith("/")
    && !value.file.split("/").includes("..")
    && Array.isArray(value.requiredPatterns)
    && value.requiredPatterns.length > 0
    && value.requiredPatterns.every((pattern) => typeof pattern === "string" && pattern.length > 0);
}
