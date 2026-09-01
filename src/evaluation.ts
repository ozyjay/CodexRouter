import { CodexModel, ReasoningEffort } from "./contracts";

export const EVALUATION_STRATEGIES = ["single-model", "fixed-roles", "proxy-candidate"] as const;
export type EvaluationStrategy = (typeof EVALUATION_STRATEGIES)[number];
export type EvaluationExecutionBackend = "codex" | "simulated" | "slm-proxy";
export type EvaluationFailureKind = "authentication" | "cli-configuration" | "model-allocation" | "worktree" | "simulation" | "proxy" | "startup-or-runtime";
export const SIMULATION_PROFILES = ["sim-small", "sim-balanced", "sim-strong"] as const;
export type SimulationProfile = (typeof SIMULATION_PROFILES)[number];

export interface Allocation {
  model: string;
  effort: ReasoningEffort;
}

export interface FixedRoleAllocations {
  [role: string]: Allocation;
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

export interface MutationCheck {
  file: string;
  search: string;
  replacement: string;
  validation: ValidationCommand;
}

export interface SimulationPatch {
  file: string;
  search: string;
  replacement: string;
}

export interface SimulationPatchSet {
  patches: SimulationPatch[];
}

export type SimulationScenario = SimulationPatch | SimulationPatchSet;

export interface SimulationRunMetadata {
  selectedProfile: SimulationProfile;
  appliedProfile: SimulationProfile;
  expectedProfile?: SimulationProfile;
  expectedProfileMatched?: boolean;
  selector: "deterministic" | "modeldeck";
  fallback: boolean;
  selectorDurationMs?: number;
  selectorModel?: { publicModelId: string; localModelId?: string; revision?: string; configurationFingerprint?: string };
}

export interface ProxyCandidateConfig {
  allowedFiles: string[];
  contextFiles: string[];
  maxPatches?: number;
  maxContextChars?: number;
}

export interface ProxyRunMetadata {
  selectedProfile: SimulationProfile;
  status: "applied" | "unavailable" | "invalid" | "inapplicable" | "context-error";
  rejectionReason?: "empty-response" | "invalid-json" | "invalid-contract";
  model?: { publicModelId: string; localModelId?: string; revision?: string; configurationFingerprint?: string };
  maxTokens?: number;
  readinessWaitMs?: number;
  readinessChecks?: number;
  candidateDurationMs: number;
  patchCount?: number;
}

export interface EvaluationCase {
  id: string;
  prompt: string;
  validation: ValidationCommand;
  expectation?: DiffExpectation;
  expectations?: DiffExpectation[];
  mutation?: MutationCheck;
  simulation?: SimulationScenario;
  simulationProfiles?: Partial<Record<SimulationProfile, SimulationScenario>>;
  expectedSimulationProfile?: SimulationProfile;
  estimatedFilesAffected?: number;
  proxy?: ProxyCandidateConfig;
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
  executionBackend: EvaluationExecutionBackend;
  allocations: Record<string, Allocation>;
  durationMs: number;
  executionExitCode: number | null;
  validationExitCode: number | null;
  expectationPassed: boolean | null;
  mutationKilled: boolean | null;
  changedFiles: boolean;
  completedAt: string;
  failureKind?: EvaluationFailureKind;
  simulation?: SimulationRunMetadata;
  proxy?: ProxyRunMetadata;
}

export interface EvaluationSummary {
  totalRuns: number;
  completedRuns: number;
  validationPassedRuns: number;
  expectationPassedRuns: number;
  mutationEvaluatedRuns: number;
  mutationKilledRuns: number;
  verifiedRuns: number;
  changedRuns: number;
  selectorExpectedRuns: number;
  selectorMatchedExpectedRuns: number;
  selectorExpectedMatchRate: number | null;
  averageDurationMs: number;
  averageVerifiedDurationMs: number | null;
  costPerVerifiedRunMs: number | null;
  byStrategy: Record<EvaluationStrategy, { total: number; validationPassed: number; expectationPassed: number; mutationEvaluated: number; mutationKilled: number; verified: number; averageDurationMs: number; averageVerifiedDurationMs: number | null; costPerVerifiedRunMs: number | null }>;
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
    if (candidate.expectations !== undefined && (!Array.isArray(candidate.expectations) || candidate.expectations.length === 0 || !candidate.expectations.every(isDiffExpectation))) errors.push(`cases[${index}] expectations must contain one or more safe diff expectations.`);
    if (candidate.mutation !== undefined && !isMutationCheck(candidate.mutation)) errors.push(`cases[${index}] mutation must name a relative file, a non-empty search string, a replacement, and a validation command.`);
    if (candidate.simulation !== undefined && !isSimulationScenario(candidate.simulation)) errors.push(`cases[${index}] simulation must name one or more safe deterministic patches.`);
    if (candidate.simulationProfiles !== undefined && !isSimulationProfiles(candidate.simulationProfiles)) errors.push(`cases[${index}] simulationProfiles must map recognised simulation profiles to safe deterministic patches.`);
    if (candidate.expectedSimulationProfile !== undefined && !SIMULATION_PROFILES.includes(candidate.expectedSimulationProfile as SimulationProfile)) errors.push(`cases[${index}] expectedSimulationProfile must be sim-small, sim-balanced, or sim-strong.`);
    if (candidate.estimatedFilesAffected !== undefined && (typeof candidate.estimatedFilesAffected !== "number" || !Number.isInteger(candidate.estimatedFilesAffected) || candidate.estimatedFilesAffected < 1 || candidate.estimatedFilesAffected > 32)) errors.push(`cases[${index}] estimatedFilesAffected must be an integer from 1 to 32.`);
    if (candidate.proxy !== undefined && !isProxyCandidateConfig(candidate.proxy)) errors.push(`cases[${index}] proxy must declare unique safe allowedFiles and contextFiles, with context files limited to allowed files.`);
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
  if (strategy === "fixed-roles") return `Complete this task through the fixed baseline roles, sequentially and without parallel delegation:\n1. Ask router_baseline_explorer to map the relevant code path, risks, and validation approach.\n2. Ask router_baseline_worker to make the smallest defensible implementation using that evidence.\n3. Ask router_baseline_reviewer to inspect the resulting diff for correctness, security, regressions, and missing tests.\n4. Repair only concrete reviewer findings, then run the specified validation command.\n\nTask:\n${task}`;
  throw new Error("proxy-candidate is a local proxy strategy and cannot build a Codex prompt.");
}

export function roleAgentFiles(roles: FixedRoleAllocations): Record<string, string> {
  return {
    "router-baseline-explorer.toml": renderAgent("router_baseline_explorer", "Read-only explorer for the fixed routing baseline.", roles.explorer, "read-only", "Map the relevant execution path, files, symbols, risks, and focused validation. Do not edit files."),
    "router-baseline-worker.toml": renderAgent("router_baseline_worker", "Implementation worker for the fixed routing baseline.", roles.worker, "workspace-write", "Implement the smallest defensible change using the explorer's evidence. Keep unrelated files untouched and run focused validation."),
    "router-baseline-reviewer.toml": renderAgent("router_baseline_reviewer", "Read-only reviewer for the fixed routing baseline.", roles.reviewer, "read-only", "Review the resulting diff for correctness, security, behaviour regressions, and missing tests. Report concrete findings only. Do not edit files.")
  };
}

export function simulationPatchForProfile(evaluationCase: EvaluationCase, requestedProfile: SimulationProfile): { profile: SimulationProfile; patch?: SimulationScenario } {
  const configured = evaluationCase.simulationProfiles?.[requestedProfile];
  if (configured) return { profile: requestedProfile, patch: configured };
  if (evaluationCase.simulation) return { profile: requestedProfile, patch: evaluationCase.simulation };
  return { profile: requestedProfile };
}

export function summariseEvaluationRuns(runs: readonly EvaluationRunResult[]): EvaluationSummary {
  const byStrategy: EvaluationSummary["byStrategy"] = {
    "single-model": { total: 0, validationPassed: 0, expectationPassed: 0, mutationEvaluated: 0, mutationKilled: 0, verified: 0, averageDurationMs: 0, averageVerifiedDurationMs: null, costPerVerifiedRunMs: null },
    "fixed-roles": { total: 0, validationPassed: 0, expectationPassed: 0, mutationEvaluated: 0, mutationKilled: 0, verified: 0, averageDurationMs: 0, averageVerifiedDurationMs: null, costPerVerifiedRunMs: null },
    "proxy-candidate": { total: 0, validationPassed: 0, expectationPassed: 0, mutationEvaluated: 0, mutationKilled: 0, verified: 0, averageDurationMs: 0, averageVerifiedDurationMs: null, costPerVerifiedRunMs: null }
  };
  const durationTotals: Record<EvaluationStrategy, number> = { "single-model": 0, "fixed-roles": 0, "proxy-candidate": 0 };
  const verifiedDurationTotals: Record<EvaluationStrategy, number> = { "single-model": 0, "fixed-roles": 0, "proxy-candidate": 0 };
  let durationTotal = 0;
  let completedRuns = 0;
  let validationPassedRuns = 0;
  let expectationPassedRuns = 0;
  let mutationEvaluatedRuns = 0;
  let mutationKilledRuns = 0;
  let verifiedRuns = 0;
  let changedRuns = 0;
  let selectorExpectedRuns = 0;
  let selectorMatchedExpectedRuns = 0;
  for (const run of runs) {
    const bucket = byStrategy[run.strategy];
    bucket.total++;
    bucket.averageDurationMs += run.durationMs;
    durationTotals[run.strategy] += run.durationMs;
    durationTotal += run.durationMs;
    if (run.executionExitCode === 0) completedRuns++;
    if (run.validationExitCode === 0) {
      validationPassedRuns++;
      bucket.validationPassed++;
    }
    if (run.expectationPassed === true) {
      expectationPassedRuns++;
      bucket.expectationPassed++;
    }
    if (run.mutationKilled !== null) {
      mutationEvaluatedRuns++;
      bucket.mutationEvaluated++;
    }
    if (run.mutationKilled === true) {
      mutationKilledRuns++;
      bucket.mutationKilled++;
    }
    if (run.validationExitCode === 0 && run.expectationPassed !== false && run.mutationKilled !== false) {
      verifiedRuns++;
      bucket.verified++;
      verifiedDurationTotals[run.strategy] += run.durationMs;
    }
    if (run.changedFiles) changedRuns++;
    if (run.simulation?.expectedProfile) {
      selectorExpectedRuns++;
      if (run.simulation.expectedProfileMatched) selectorMatchedExpectedRuns++;
    }
  }
  for (const bucket of Object.values(byStrategy)) {
    bucket.averageDurationMs = bucket.total === 0 ? 0 : Math.round(bucket.averageDurationMs / bucket.total);
  }
  for (const strategy of EVALUATION_STRATEGIES) {
    const bucket = byStrategy[strategy];
    bucket.averageVerifiedDurationMs = bucket.verified === 0 ? null : Math.round(verifiedDurationTotals[strategy] / bucket.verified);
    bucket.costPerVerifiedRunMs = bucket.verified === 0 ? null : Math.round(durationTotals[strategy] / bucket.verified);
  }
  return {
    totalRuns: runs.length,
    completedRuns,
    validationPassedRuns,
    expectationPassedRuns,
    mutationEvaluatedRuns,
    mutationKilledRuns,
    verifiedRuns,
    changedRuns,
    selectorExpectedRuns,
    selectorMatchedExpectedRuns,
    selectorExpectedMatchRate: selectorExpectedRuns === 0 ? null : Number((selectorMatchedExpectedRuns / selectorExpectedRuns).toFixed(4)),
    averageDurationMs: runs.length === 0 ? 0 : Math.round(durationTotal / runs.length),
    averageVerifiedDurationMs: verifiedRuns === 0 ? null : Math.round(Object.values(verifiedDurationTotals).reduce((total, duration) => total + duration, 0) / verifiedRuns),
    costPerVerifiedRunMs: verifiedRuns === 0 ? null : Math.round(durationTotal / verifiedRuns),
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
    && isSafeRelativeFile(value.file)
    && Array.isArray(value.requiredPatterns)
    && value.requiredPatterns.length > 0
    && value.requiredPatterns.every((pattern) => typeof pattern === "string" && pattern.length > 0);
}

function isMutationCheck(value: unknown): value is MutationCheck {
  return isRecord(value)
    && isSafeRelativeFile(value.file)
    && typeof value.search === "string"
    && value.search.length > 0
    && typeof value.replacement === "string"
    && isValidationCommand(value.validation);
}

function isSimulationPatch(value: unknown): value is SimulationPatch {
  return isRecord(value)
    && isSafeRelativeFile(value.file)
    && typeof value.search === "string"
    && value.search.length > 0
    && typeof value.replacement === "string";
}

function isSimulationProfiles(value: unknown): value is Partial<Record<SimulationProfile, SimulationScenario>> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([profile, patch]) => SIMULATION_PROFILES.includes(profile as SimulationProfile) && isSimulationScenario(patch));
}

function isSimulationScenario(value: unknown): value is SimulationScenario {
  return isSimulationPatch(value)
    || (isRecord(value) && Array.isArray(value.patches) && value.patches.length > 0 && value.patches.every(isSimulationPatch));
}

function isProxyCandidateConfig(value: unknown): value is ProxyCandidateConfig {
  if (!isRecord(value)) return false;
  const allowedFiles = value.allowedFiles;
  const contextFiles = value.contextFiles;
  if (!isSafeFileList(allowedFiles)
    || !isSafeFileList(contextFiles)
    || !contextFiles.every((file) => allowedFiles.includes(file))) return false;
  return (value.maxPatches === undefined || (typeof value.maxPatches === "number" && Number.isInteger(value.maxPatches) && value.maxPatches >= 1 && value.maxPatches <= 8))
    && (value.maxContextChars === undefined || (typeof value.maxContextChars === "number" && Number.isInteger(value.maxContextChars) && value.maxContextChars >= 256 && value.maxContextChars <= 48_000));
}

function isSafeFileList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isSafeRelativeFile) && new Set(value).size === value.length;
}

function isSafeRelativeFile(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..");
}
