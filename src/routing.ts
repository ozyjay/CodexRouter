import { CodexModel, REASONING_ORDER, ReasoningEffort, RoutingInput, RoutingRecommendation, TargetModelTier } from "./contracts";

const RISK_PATTERN = /\b(auth(?:entication|orization)?|oauth|token|credential|password|crypto(?:graphy)?|encrypt|decrypt|secret|security|vulnerabilit|delete|drop\s+(?:table|database)|irreversible|migration|upgrade|concurren|race condition|distributed)\b/i;
const BROAD_PATTERN = /\b(architecture|redesign|refactor|multiple (?:services|subsystems|packages)|across the (?:repo|codebase)|unknown|investigate)\b/i;

export function isValidRecommendation(value: unknown): value is RoutingRecommendation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RoutingRecommendation>;
  return typeof candidate.recommendedModel === "string"
    && typeof candidate.recommendedEffort === "string"
    && typeof candidate.confidence === "number"
    && candidate.confidence >= 0 && candidate.confidence <= 1
    && Array.isArray(candidate.reasons) && candidate.reasons.length <= 3
    && candidate.reasons.every((reason) => typeof reason === "string" && reason.length <= 240)
    && Array.isArray(candidate.escalationSignals) && candidate.escalationSignals.length <= 4;
}

export function fallbackRoute(input: RoutingInput): RoutingRecommendation {
  const task = input.task.trim();
  const elevatedRisk = RISK_PATTERN.test(task);
  const broad = BROAD_PATTERN.test(task) || task.length > 900;
  const narrow = !elevatedRisk && !broad && task.length <= 280
    && /\b(rename|format|typo|comment|readme|test fixture|update version|add test)\b/i.test(task);

  if (elevatedRisk || broad) {
    return recommendation("sol", "high", 0.72, "high", elevatedRisk ? "high" : "elevated", [
      elevatedRisk ? "The task has a security, destructive, migration, or concurrency signal." : "The task may require architectural judgement across a broad area.",
      "Higher reasoning is safer until scope and verification are clear."
    ]);
  }
  if (narrow) {
    return recommendation("luna", "low", 0.78, "low", "normal", [
      "The task is explicit and mechanically bounded.",
      "A low reasoning budget should be sufficient if verification remains clear."
    ]);
  }
  return recommendation("terra", "medium", 0.7, "moderate", "normal", [
    "The task appears to be ordinary bounded software work.",
    "Medium reasoning is a balanced starting point pending stronger evidence."
  ]);
}

export function applyGuardrails(candidate: RoutingRecommendation, input: RoutingInput, models: CodexModel[]): RoutingRecommendation {
  const fallback = fallbackRoute(input);
  const highRisk = fallback.risk === "high";
  const preferredTier: TargetModelTier = highRisk ? "sol" : tierFromModel(candidate.recommendedModel) ?? "terra";
  const preferredEffort = highRisk ? "high" : candidate.recommendedEffort;
  const selectedModel = selectModel(preferredTier, models);
  const selectedEffort = selectEffort(preferredEffort, selectedModel);
  const reasons = highRisk && !candidate.reasons.some((reason) => RISK_PATTERN.test(reason))
    ? ["Deterministic safety guardrail escalated a consequential-task signal.", ...candidate.reasons].slice(0, 3)
    : candidate.reasons.slice(0, 3);

  return {
    ...candidate,
    ...(highRisk ? {
      scope: fallback.scope,
      complexity: fallback.complexity,
      risk: fallback.risk,
      ambiguity: fallback.ambiguity,
      escalationSignals: [...new Set([...fallback.escalationSignals, ...candidate.escalationSignals])].slice(0, 4)
    } : {}),
    recommendedModel: selectedModel.model,
    recommendedEffort: selectedEffort,
    confidence: clamp(candidate.confidence),
    reasons,
    source: candidate.source
  };
}

export function selectModel(tier: TargetModelTier, models: CodexModel[]): CodexModel {
  const visible = models.filter((model) => !model.hidden);
  const catalogue = visible.length ? visible : models;
  const byTier = catalogue.find((model) => tierFromModel(model.model) === tier || tierFromModel(model.id) === tier);
  if (byTier) return byTier;
  const safeFallback = ["sol", "terra", "luna"]
    .map((candidateTier) => catalogue.find((model) => tierFromModel(model.model) === candidateTier || tierFromModel(model.id) === candidateTier))
    .find((model): model is CodexModel => Boolean(model));
  if (safeFallback) return safeFallback;
  const defaultModel = catalogue.find((model) => model.isDefault);
  if (defaultModel) return defaultModel;
  throw new Error("Codex App Server did not report an available model.");
}

export function selectEffort(preferred: ReasoningEffort, model: CodexModel): ReasoningEffort {
  const available = model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort);
  if (available.includes(preferred)) return preferred;
  const requestedIndex = REASONING_ORDER.indexOf(preferred as (typeof REASONING_ORDER)[number]);
  const higher = available
    .filter((effort) => REASONING_ORDER.indexOf(effort as (typeof REASONING_ORDER)[number]) >= requestedIndex)
    .sort((a, b) => REASONING_ORDER.indexOf(a as (typeof REASONING_ORDER)[number]) - REASONING_ORDER.indexOf(b as (typeof REASONING_ORDER)[number]))[0];
  return higher ?? model.defaultReasoningEffort;
}

function recommendation(tier: TargetModelTier, effort: ReasoningEffort, confidence: number, complexity: RoutingRecommendation["complexity"], risk: RoutingRecommendation["risk"], reasons: string[]): RoutingRecommendation {
  return {
    taskType: "implementation",
    scope: complexity === "high" ? "broad" : complexity === "low" ? "narrow" : "medium",
    complexity,
    risk,
    ambiguity: complexity === "high" ? "medium" : "low",
    recommendedModel: `gpt-5.6-${tier}`,
    recommendedEffort: effort,
    confidence,
    reasons,
    escalationSignals: ["Verification fails after two repair turns.", "The task expands beyond the initially selected files."],
    source: "deterministic-fallback"
  };
}

function tierFromModel(model: string): TargetModelTier | undefined {
  return (["luna", "terra", "sol"] as const).find((tier) => model.toLowerCase().includes(tier));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
