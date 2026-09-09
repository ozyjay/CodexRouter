import { CodexModel, RoutingInput, RoutingRecommendation, TurnPhase, TurnPlan } from "./contracts";
import { applyGuardrails } from "./routing";

export interface TurnPlanCandidate {
  strategy: "single-turn" | "sequential-turns";
  turns: Array<{ phase: TurnPhase; model: string; effort: string }>;
  reasons: string[];
}

const PHASE_ORDER: TurnPhase[] = ["exploration", "implementation", "review"];

export const TURN_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["strategy", "turns", "reasons"],
  properties: {
    strategy: { type: "string", enum: ["single-turn", "sequential-turns"] },
    turns: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phase", "model", "effort"],
        properties: {
          phase: { type: "string", enum: PHASE_ORDER },
          model: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:/-]+$" },
          effort: { type: "string", minLength: 1, maxLength: 32, pattern: "^[A-Za-z0-9_-]+$" }
        }
      }
    },
    reasons: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 240, pattern: "^[^\\r\\n]+$" }
    }
  }
} as const;

/** Field names only: rejected local output is not copied into ordinary diagnostics. */
export function turnPlanValidationIssues(value: unknown, models: readonly CodexModel[]): string[] {
  if (!isRecord(value)) return ["object"];
  const issues: string[] = [];
  if (!hasExactKeys(value, ["strategy", "turns", "reasons"])) issues.push("unexpected-fields");
  if (value.strategy !== "single-turn" && value.strategy !== "sequential-turns") issues.push("strategy");
  if (!Array.isArray(value.reasons) || value.reasons.length < 1 || value.reasons.length > 3 || !value.reasons.every(isBoundedLine)) issues.push("reasons");
  if (!Array.isArray(value.turns) || value.turns.length < 1 || value.turns.length > 3) {
    issues.push("turns");
    return issues;
  }

  const turns = value.turns;
  const phases: TurnPhase[] = [];
  for (const turn of turns) {
    if (!isRecord(turn) || !hasExactKeys(turn, ["phase", "model", "effort"])) {
      issues.push("turn-fields");
      continue;
    }
    if (!PHASE_ORDER.includes(turn.phase as TurnPhase)) issues.push("turn-phase");
    else phases.push(turn.phase as TurnPhase);
    if (typeof turn.model !== "string" || typeof turn.effort !== "string" || !supportsAllocation(turn.model, turn.effort, models)) {
      issues.push("turn-allocation");
    }
  }

  const sequential = value.strategy === "sequential-turns";
  if ((!sequential && (turns.length !== 1 || phases[0] !== "implementation"))
    || (sequential && (turns.length < 2 || !phases.includes("implementation")))) issues.push("strategy-turns");
  if (new Set(phases).size !== phases.length || phases.some((phase, index) => index > 0 && PHASE_ORDER.indexOf(phase) <= PHASE_ORDER.indexOf(phases[index - 1]))) issues.push("phase-order");
  return [...new Set(issues)];
}

export function buildTurnPlan(candidate: TurnPlanCandidate, input: RoutingInput, models: CodexModel[], base: RoutingRecommendation): TurnPlan {
  const issues = turnPlanValidationIssues(candidate, models);
  if (issues.length) throw new Error(`Local turn plan is invalid: ${issues.join(", ")}.`);
  return {
    strategy: candidate.strategy,
    reasons: candidate.reasons,
    source: "local-model",
    classifierModel: base.classifierModel,
    turns: candidate.turns.map((turn) => ({
      phase: turn.phase,
      recommendation: applyGuardrails({
        ...base,
        recommendedModel: turn.model,
        recommendedEffort: turn.effort,
        reasons: [`${phaseLabel(turn.phase)} turn selected by the local planner.`, ...candidate.reasons].slice(0, 3)
      }, input, models)
    }))
  };
}

export function singleTurnPlan(recommendation: RoutingRecommendation, providerFallback?: TurnPlan["providerFallback"]): TurnPlan {
  return {
    strategy: "single-turn",
    turns: [{ phase: "implementation", recommendation }],
    reasons: ["Use one Codex turn for this task."],
    source: recommendation.source,
    classifierModel: recommendation.classifierModel,
    providerFallback
  };
}

export function phasePrompt(phase: TurnPhase, turnNumber: number, turnCount: number, originalTask?: string): string {
  const header = `Codex Router phase ${turnNumber} of ${turnCount}: ${phaseLabel(phase)}.`;
  const instruction = phase === "exploration"
    ? "Inspect the relevant repository context and determine the concrete implementation approach. Do not edit files in this phase. End with concise findings for the next turn."
    : phase === "implementation"
      ? "Complete the original request using the conversation context. Make the required changes and run focused verification."
      : "Review the work completed in earlier phases for correctness, regressions and missing tests. Fix any issues you find and run the relevant verification before reporting the final result.";
  return [originalTask?.trim(), `${header}\n${instruction}`].filter(Boolean).join("\n\n");
}

export function phaseLabel(phase: TurnPhase): string {
  return phase === "exploration" ? "Exploration" : phase === "implementation" ? "Implementation" : "Review";
}

function isBoundedLine(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 240 && !/[\r\n]/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function supportsAllocation(modelId: string, effort: string, models: readonly CodexModel[]): boolean {
  const model = models.find((candidate) => !candidate.hidden && (candidate.id === modelId || candidate.model === modelId));
  return Boolean(model?.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === effort));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
