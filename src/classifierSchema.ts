import { ClassifierRecommendation } from "./contracts";

interface FieldRule {
  type: "string" | "number" | "array";
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: FieldRule;
  description?: string;
}

const text: FieldRule = { type: "string", minLength: 1, maxLength: 240, pattern: "^[^\\r\\n]+$" };
const properties: Record<keyof ClassifierRecommendation, FieldRule> = {
  taskType: { type: "string", enum: ["implementation", "debugging", "documentation", "testing", "refactor", "other"] },
  scope: { type: "string", enum: ["narrow", "medium", "broad"] },
  complexity: { type: "string", enum: ["low", "moderate", "high"], description: "Difficulty of the work, independent of safety risk." },
  risk: { type: "string", enum: ["normal", "elevated", "high"], description: "Potential harm from execution. Creative novelty, uncertainty and brainstorming alone are normal risk." },
  ambiguity: { type: "string", enum: ["low", "medium", "high"], description: "Missing requirements or context; a follow-up using 'this' without source context is ambiguous." },
  recommendedModel: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:/-]+$" },
  recommendedEffort: { type: "string", minLength: 1, maxLength: 32, pattern: "^[A-Za-z0-9_-]+$" },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  reasons: { type: "array", minItems: 1, maxItems: 3, items: text },
  escalationSignals: { type: "array", minItems: 0, maxItems: 4, items: text, description: "Concrete signals present in the task, not hypothetical future complications. Use [] if none." }
};

export const CLASSIFIER_SCHEMA = { type: "object", additionalProperties: false, required: Object.keys(properties), properties };

function matches(value: unknown, rule: FieldRule): boolean {
  if (rule.type === "string") return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value)
    && (!rule.enum || rule.enum.includes(value))
    && (rule.minLength === undefined || value.length >= rule.minLength)
    && (rule.maxLength === undefined || value.length <= rule.maxLength)
    && (!rule.pattern || new RegExp(rule.pattern).test(value));
  if (rule.type === "number") return typeof value === "number" && Number.isFinite(value)
    && (rule.minimum === undefined || value >= rule.minimum) && (rule.maximum === undefined || value <= rule.maximum);
  return Array.isArray(value) && value.length >= (rule.minItems ?? 0) && value.length <= (rule.maxItems ?? Infinity)
    && value.every((item) => rule.items && matches(item, rule.items));
}

/** Field names only: invalid model output is never copied into ordinary diagnostics. */
export function classifierValidationIssues(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["object"];
  const record = value as Record<string, unknown>;
  const issues = Object.entries(properties).filter(([key, rule]) => !matches(record[key], rule)).map(([key]) => key);
  if (Object.keys(record).some((key) => !Object.hasOwn(properties, key))) issues.push("unexpected-fields");
  return issues;
}

/** Explicit legacy alias observed in local classifier output; unknown values still fail closed. */
export function normaliseClassifierRisk(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).risk === "low") return { ...value, risk: "normal" };
  return value;
}
