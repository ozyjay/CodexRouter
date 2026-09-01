import {
  CatalogueFallback,
  ClassifierRecommendation,
  CodexModel,
  REASONING_ORDER,
  ROUTING_POLICY_VERSION,
  ReasoningEffort,
  RecommendationStrength,
  RoutingAssessment,
  RoutingInput,
  RoutingRecommendation,
  TargetModelTier
} from "./contracts";

const BROAD_PATTERN = /\b(architecture|redesign|across the (?:repo|codebase)|multiple (?:services|subsystems|packages)|repository-wide|system-wide)\b/i;
const AMBIGUOUS_PATTERN = /\b(investigate|unknown|explore|research|decide|evaluate options|root cause|work out|figure out)\b/i;
const NARROW_PATTERN = /\b(rename|format|typo|comment|readme|test fixture|update version|add (?:a |one )?test|single file|exactly one)\b/i;
const DOCUMENTATION_PATTERN = /\b(document(?:ation)?|docs?|readme|comment|explain|describe|guide|example)\b/i;
const IMPLEMENTATION_ACTION_PATTERN = /\b(implement|change|modify|fix|add|remove|delete|rotate|migrate|upgrade|secure|enforce|validate|refactor|execute)\b/i;

type RiskSignal = RoutingAssessment["riskSignals"][number];

const RISK_PATTERNS: Array<[RiskSignal, RegExp]> = [
  ["security", /\b(auth(?:entication|orisation|orization)?|oauth|security|vulnerabilit|encrypt|decrypt|cryptograph)\b/i],
  ["credentials", /\b(token|credentials?|password|secret|private key)\b/i],
  ["migration", /\b(migrate|migration|schema change|database upgrade|data conversion)\b/i],
  ["destructive", /\b(delete|drop\s+(?:table|database)|truncate|irreversible|destroy|purge)\b/i],
  ["concurrency", /\b(concurren|race condition|deadlock|locking|atomicity)\b/i],
  ["distributed", /\b(distributed|consensus|replication|multi-region|eventual consistency)\b/i],
  ["data-integrity", /\b(data integrity|corruption|transaction|rollback|idempotency)\b/i]
];

const EXPECTED_CLASSIFIER_KEYS = [
  "taskType", "scope", "complexity", "risk", "ambiguity", "recommendedModel", "recommendedEffort", "confidence", "reasons", "escalationSignals"
] as const;

export function isValidRecommendation(value: unknown): value is ClassifierRecommendation {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== EXPECTED_CLASSIFIER_KEYS.length || !EXPECTED_CLASSIFIER_KEYS.every((key) => key in value)) return false;
  return ["implementation", "debugging", "documentation", "testing", "refactor", "other"].includes(value.taskType as string)
    && ["narrow", "medium", "broad"].includes(value.scope as string)
    && ["low", "moderate", "high"].includes(value.complexity as string)
    && ["normal", "elevated", "high"].includes(value.risk as string)
    && ["low", "medium", "high"].includes(value.ambiguity as string)
    && typeof value.recommendedModel === "string" && value.recommendedModel.length > 0
    && typeof value.recommendedEffort === "string" && value.recommendedEffort.length > 0
    && typeof value.confidence === "number" && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    && Array.isArray(value.reasons) && value.reasons.length > 0 && value.reasons.length <= 3
    && value.reasons.every((reason) => typeof reason === "string" && reason.trim().length > 0 && reason.length <= 240 && !/[\r\n]/.test(reason))
    && Array.isArray(value.escalationSignals) && value.escalationSignals.length <= 4
    && value.escalationSignals.every((signal) => typeof signal === "string" && signal.length <= 240 && !/[\r\n]/.test(signal));
}

export function assessTask(input: RoutingInput): RoutingAssessment {
  const task = input.task.trim();
  const documentationOnly = DOCUMENTATION_PATTERN.test(task) && !IMPLEMENTATION_ACTION_PATTERN.test(task.replace(DOCUMENTATION_PATTERN, ""));
  const riskSignals = documentationOnly ? [] : RISK_PATTERNS.filter(([, pattern]) => pattern.test(task)).map(([signal]) => signal);
  const broad = BROAD_PATTERN.test(task) || task.length > 900;
  const ambiguous = AMBIGUOUS_PATTERN.test(task) || /\b(design|approach|strategy)\b/i.test(task);
  const narrow = !broad && !ambiguous && riskSignals.length === 0 && task.length <= 320 && NARROW_PATTERN.test(task);
  const destructive = riskSignals.includes("destructive");
  const architectural = broad || riskSignals.some((signal) => ["migration", "concurrency", "distributed"].includes(signal));
  const consequential = riskSignals.length > 0;

  return {
    scope: broad ? "broad" : narrow ? "narrow" : "medium",
    ambiguity: ambiguous ? (broad ? "high" : "medium") : "low",
    exploration: broad || AMBIGUOUS_PATTERN.test(task) ? "high" : narrow ? "low" : "medium",
    architecturalJudgement: architectural ? "high" : ambiguous ? "medium" : "low",
    reversibility: destructive ? "difficult" : consequential ? "moderate" : "easy",
    blastRadius: broad || destructive || riskSignals.includes("migration") ? "high" : consequential ? "medium" : "low",
    verificationBurden: consequential || broad ? "high" : narrow ? "low" : "medium",
    riskSignals,
    boundedRepeatable: narrow
  };
}

export function fallbackRoute(input: RoutingInput): RoutingRecommendation {
  const assessment = assessTask(input);
  const high = assessment.riskSignals.length > 0 || assessment.scope === "broad" || assessment.architecturalJudgement === "high" || assessment.ambiguity === "high";
  const low = assessment.boundedRepeatable && assessment.verificationBurden === "low";
  const tier: TargetModelTier = high ? "sol" : low ? "luna" : "terra";
  const effort: ReasoningEffort = high ? "high" : low ? "low" : "medium";
  const reasons = reasonsForAssessment(assessment, tier);
  return {
    taskType: taskType(input.task),
    scope: assessment.scope,
    complexity: high ? "high" : low ? "low" : "moderate",
    risk: assessment.riskSignals.length > 0 ? "high" : assessment.scope === "broad" || assessment.ambiguity === "high" ? "elevated" : "normal",
    ambiguity: assessment.ambiguity,
    recommendedModel: `gpt-5.6-${tier}`,
    recommendedEffort: effort,
    strength: recommendationStrength(assessment),
    policyVersion: ROUTING_POLICY_VERSION,
    reasons,
    escalationSignals: escalationSignals(assessment),
    source: "deterministic",
    assessment
  };
}

export function deterministicRoute(input: RoutingInput, models: CodexModel[]): RoutingRecommendation {
  return applyGuardrails(fallbackRoute(input), input, models);
}

export function applyGuardrails(candidate: RoutingRecommendation, input: RoutingInput, models: CodexModel[]): RoutingRecommendation {
  const baseline = fallbackRoute(input);
  const baselineTier = tierFromModel(baseline.recommendedModel) ?? "terra";
  const candidateTier = tierFromModel(candidate.recommendedModel);
  const candidateEffortIndex = REASONING_ORDER.indexOf(candidate.recommendedEffort as (typeof REASONING_ORDER)[number]);
  const baselineEffortIndex = REASONING_ORDER.indexOf(baseline.recommendedEffort as (typeof REASONING_ORDER)[number]);
  const guardrailEscalated = baseline.risk === "high" && (
    !candidateTier
    || tierIndex(candidateTier) < tierIndex(baselineTier)
    || candidateEffortIndex < baselineEffortIndex
  );
  const desiredTier = guardrailEscalated ? baselineTier : candidateTier ?? "terra";
  const desiredEffort = guardrailEscalated ? baseline.recommendedEffort : candidate.recommendedEffort;
  const selection = selectCatalogueAllocation(desiredTier, desiredEffort, models);
  const reasons = guardrailEscalated
    ? [`Safety guardrail retained ${baseline.assessment.riskSignals.join(", ")} risk escalation.`, ...candidate.reasons].slice(0, 3)
    : candidate.reasons.slice(0, 3);

  return {
    ...candidate,
    ...(guardrailEscalated ? {
      taskType: baseline.taskType,
      scope: baseline.scope,
      complexity: baseline.complexity,
      risk: baseline.risk,
      ambiguity: baseline.ambiguity,
      strength: baseline.strength,
      assessment: baseline.assessment,
      escalationSignals: [...new Set([...baseline.escalationSignals, ...candidate.escalationSignals])].slice(0, 4),
      providerFallback: "guardrail-escalation" as const
    } : {}),
    policyVersion: candidate.source === "local-model" ? candidate.policyVersion : ROUTING_POLICY_VERSION,
    recommendedModel: selection.model.model,
    recommendedEffort: selection.effort,
    catalogueFallback: selection.fallback,
    reasons
  };
}

export function selectCatalogueAllocation(tier: TargetModelTier, effort: ReasoningEffort, models: CodexModel[]): { model: CodexModel; effort: ReasoningEffort; fallback?: CatalogueFallback } {
  const model = selectModel(tier, models);
  const selectedEffort = selectEffort(effort, model);
  const selectedTier = tierFromModel(model.model) ?? tierFromModel(model.id);
  let reason: CatalogueFallback["reason"] | undefined;
  if (!selectedTier) reason = "unrecognised-catalogue";
  else if (selectedTier !== tier) reason = "model-tier-unavailable";
  else if (selectedEffort !== effort) reason = "effort-unavailable";
  return {
    model,
    effort: selectedEffort,
    fallback: reason ? { requestedModelTier: tier, requestedEffort: effort, reason } : undefined
  };
}

export function selectModel(tier: TargetModelTier, models: CodexModel[]): CodexModel {
  const visible = models.filter((model) => !model.hidden);
  const selectable = visible.length > 0 ? visible : models.filter((model) => model.isDefault);
  if (selectable.length === 0) throw new Error("Codex App Server did not report a selectable model.");
  const fallbackOrder: Record<TargetModelTier, TargetModelTier[]> = {
    luna: ["luna", "terra", "sol"],
    terra: ["terra", "sol", "luna"],
    sol: ["sol", "terra", "luna"]
  };
  for (const candidateTier of fallbackOrder[tier]) {
    const match = selectable.find((model) => tierFromModel(model.model) === candidateTier || tierFromModel(model.id) === candidateTier);
    if (match) return match;
  }
  return selectable.find((model) => model.isDefault) ?? selectable[0];
}

export function selectEffort(preferred: ReasoningEffort, model: CodexModel): ReasoningEffort {
  const available = model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort);
  if (available.length === 0) throw new Error(`Codex model ${model.model} advertises no supported reasoning efforts.`);
  if (available.includes(preferred)) return preferred;
  const requestedIndex = REASONING_ORDER.indexOf(preferred as (typeof REASONING_ORDER)[number]);
  if (requestedIndex < 0) return available.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : available[0];
  const recognised = available.filter((effort) => REASONING_ORDER.includes(effort as (typeof REASONING_ORDER)[number]));
  const higher = recognised
    .filter((effort) => REASONING_ORDER.indexOf(effort as (typeof REASONING_ORDER)[number]) >= requestedIndex)
    .sort((a, b) => REASONING_ORDER.indexOf(a as (typeof REASONING_ORDER)[number]) - REASONING_ORDER.indexOf(b as (typeof REASONING_ORDER)[number]))[0];
  if (higher) return higher;
  return recognised.sort((a, b) => REASONING_ORDER.indexOf(b as (typeof REASONING_ORDER)[number]) - REASONING_ORDER.indexOf(a as (typeof REASONING_ORDER)[number]))[0]
    ?? (available.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : available[0]);
}

function recommendationStrength(assessment: RoutingAssessment): RecommendationStrength {
  const decisiveRisk = assessment.riskSignals.length > 0 && assessment.ambiguity !== "high";
  if (assessment.boundedRepeatable || decisiveRisk || (assessment.scope === "broad" && assessment.ambiguity !== "high")) return "strong";
  if (assessment.ambiguity === "high" || (assessment.scope === "medium" && assessment.exploration === "high")) return "weak";
  return "moderate";
}

function reasonsForAssessment(assessment: RoutingAssessment, tier: TargetModelTier): string[] {
  const reasons: string[] = [];
  if (assessment.riskSignals.length > 0) reasons.push(`Consequential ${assessment.riskSignals.join(", ")} work requires conservative allocation.`);
  if (assessment.scope === "broad") reasons.push("The requested scope spans a broad area.");
  if (assessment.ambiguity !== "low") reasons.push("The task requires exploration or judgement before implementation.");
  if (assessment.boundedRepeatable) reasons.push("The task is explicit, bounded and repeatable.");
  if (assessment.verificationBurden === "high") reasons.push("Verification has a high burden or blast radius.");
  if (reasons.length === 0) reasons.push(tier === "terra" ? "The task is ordinary bounded software work." : "The task matches the selected policy tier.");
  return reasons.slice(0, 3);
}

function escalationSignals(assessment: RoutingAssessment): string[] {
  const signals = assessment.riskSignals.map((signal) => `Detected ${signal} risk.`);
  if (assessment.scope === "broad") signals.push("Broad repository scope detected.");
  if (assessment.ambiguity === "high") signals.push("High uncertainty detected.");
  return signals.slice(0, 4);
}

function taskType(task: string): RoutingRecommendation["taskType"] {
  if (DOCUMENTATION_PATTERN.test(task)) return "documentation";
  if (/\b(test|spec|fixture|coverage)\b/i.test(task)) return "testing";
  if (/\b(debug|investigate|root cause|regression|broken|failing)\b/i.test(task)) return "debugging";
  if (/\b(refactor|restructure|rename)\b/i.test(task)) return "refactor";
  if (/\b(implement|add|fix|change|modify|remove|delete|migrate)\b/i.test(task)) return "implementation";
  return "other";
}

function tierFromModel(model: string): TargetModelTier | undefined {
  return (["luna", "terra", "sol"] as const).find((tier) => model.toLowerCase().includes(tier));
}

function tierIndex(tier: TargetModelTier): number {
  return ["luna", "terra", "sol"].indexOf(tier);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
