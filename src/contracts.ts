export const TARGET_MODEL_TIERS = ["luna", "terra", "sol"] as const;
export type TargetModelTier = (typeof TARGET_MODEL_TIERS)[number];

export const REASONING_ORDER = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_ORDER)[number] | string;

export const ROUTING_POLICY_VERSION = "deterministic-v1";
export const MODELDECK_POLICY_VERSION = "modeldeck-experimental-v1+deterministic-v1-guardrails";
export const OUTCOME_SCHEMA_VERSION = 2;

export type RecommendationStrength = "weak" | "moderate" | "strong";
export type RoutingSource = "deterministic" | "local-model";
export type RoutingProvider = "deterministic" | "modeldeck-experimental";
export type TurnState = "completed" | "failed" | "cancelled";

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: ReasoningEffort; description?: string }>;
  defaultReasoningEffort: ReasoningEffort;
  isDefault: boolean;
}

export interface RoutingAssessment {
  scope: "narrow" | "medium" | "broad";
  ambiguity: "low" | "medium" | "high";
  exploration: "low" | "medium" | "high";
  architecturalJudgement: "low" | "medium" | "high";
  reversibility: "easy" | "moderate" | "difficult";
  blastRadius: "low" | "medium" | "high";
  verificationBurden: "low" | "medium" | "high";
  riskSignals: Array<"security" | "credentials" | "migration" | "destructive" | "concurrency" | "distributed" | "data-integrity">;
  boundedRepeatable: boolean;
}

export interface CatalogueFallback {
  requestedModelTier: TargetModelTier;
  requestedEffort: ReasoningEffort;
  reason: "model-tier-unavailable" | "effort-unavailable" | "unrecognised-catalogue";
}

export type ProviderFallback = "unavailable" | "timeout" | "malformed" | "no-ready-model" | "unsupported-allocation" | "guardrail-escalation";

export interface RoutingRecommendation {
  taskType: "implementation" | "debugging" | "documentation" | "testing" | "refactor" | "other";
  scope: "narrow" | "medium" | "broad";
  complexity: "low" | "moderate" | "high";
  risk: "normal" | "elevated" | "high";
  ambiguity: "low" | "medium" | "high";
  recommendedModel: string;
  recommendedEffort: ReasoningEffort;
  confidence?: number;
  strength: RecommendationStrength;
  policyVersion: string;
  reasons: string[];
  escalationSignals: string[];
  source: RoutingSource;
  assessment: RoutingAssessment;
  classifierModel?: string;
  catalogueFallback?: CatalogueFallback;
  providerFallback?: ProviderFallback;
}

export interface ClassifierRecommendation {
  taskType: RoutingRecommendation["taskType"];
  scope: RoutingRecommendation["scope"];
  complexity: RoutingRecommendation["complexity"];
  risk: RoutingRecommendation["risk"];
  ambiguity: RoutingRecommendation["ambiguity"];
  recommendedModel: string;
  recommendedEffort: ReasoningEffort;
  confidence: number;
  reasons: string[];
  escalationSignals: string[];
}

export interface RoutingMetadata {
  languageId?: string;
  relativeFileName?: string;
  workspaceFolderCount?: number;
  selectionPresent?: boolean;
  selectedCharacters?: number;
}

export interface RoutingInput {
  task: string;
  metadata?: RoutingMetadata;
}

export interface SelectedExcerpt {
  content: string;
  relativeFileName?: string;
  languageId?: string;
}

export interface RoutingSessionInput {
  routing: RoutingInput;
  execution: {
    task: string;
    selectedExcerpt?: SelectedExcerpt;
  };
}

export interface AllocationSelection {
  model: string;
  effort: ReasoningEffort;
  overridden: boolean;
}

export interface OutcomeRecord {
  schemaVersion: 2;
  recordId: string;
  timestamp: string;
  workspaceId: string;
  policyVersion: string;
  taskType: RoutingRecommendation["taskType"];
  routingSource: RoutingSource;
  classifierModel?: string;
  recommendationStrength: RecommendationStrength;
  recommendation: Pick<RoutingRecommendation, "recommendedModel" | "recommendedEffort">;
  selected: AllocationSelection;
  durationMs: number;
  turnState: TurnState;
  taskOutcome: "completed" | "incomplete" | "failed" | "unreported";
  validationStatus: "passed" | "failed" | "not-run" | "not-observed" | "unreported";
  repairTurns?: number;
  allocationJudgement: "appropriate" | "under-powered" | "over-powered" | "unsure" | "unreported";
  catalogueFallback?: CatalogueFallback["reason"];
  providerFallback?: ProviderFallback;
}
