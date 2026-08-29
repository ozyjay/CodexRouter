export const TARGET_MODEL_TIERS = ["luna", "terra", "sol"] as const;
export type TargetModelTier = (typeof TARGET_MODEL_TIERS)[number];

export const REASONING_ORDER = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_ORDER)[number] | string;

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

export interface RoutingRecommendation {
  taskType: "implementation" | "debugging" | "documentation" | "testing" | "refactor" | "other";
  scope: "narrow" | "medium" | "broad";
  complexity: "low" | "moderate" | "high";
  risk: "normal" | "elevated" | "high";
  ambiguity: "low" | "medium" | "high";
  recommendedModel: string;
  recommendedEffort: ReasoningEffort;
  confidence: number;
  reasons: string[];
  escalationSignals: string[];
  source: "local-model" | "deterministic-fallback";
}

export interface RoutingInput {
  task: string;
  languageId?: string;
  selectedFileName?: string;
  workspaceName?: string;
}

export interface OutcomeRecord {
  timestamp: string;
  workspaceId: string;
  taskType: RoutingRecommendation["taskType"];
  recommendation: Pick<RoutingRecommendation, "recommendedModel" | "recommendedEffort" | "confidence" | "source">;
  selected: { model: string; effort: ReasoningEffort; overridden: boolean };
  durationMs?: number;
  completionStatus?: "completed" | "failed" | "cancelled";
  validationStatus?: "passed" | "failed" | "not-observed";
  repairTurns?: number;
  userRating?: "success" | "unsure" | "failure";
}
