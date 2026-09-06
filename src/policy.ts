import { CodexModel, RoutingInput, RoutingProvider, RoutingRecommendation } from "./contracts";
import { classifyModelDeckFailure, modelDeckFailureDiagnostic, modelDeckRawFailureResponse } from "./modelDeck";
import { applyGuardrails, deterministicRoute } from "./routing";

export interface ExperimentalRoutingClassifier {
  classify(input: RoutingInput, models: readonly CodexModel[]): Promise<RoutingRecommendation>;
}

export interface AllocationDiagnostic {
  reason: "model-not-advertised" | "model-hidden" | "effort-not-supported";
  requestedModel: string;
  requestedEffort: string;
  supportedEfforts?: string[];
}

export async function recommendWithProvider(
  input: RoutingInput,
  models: CodexModel[],
  provider: RoutingProvider,
  createClassifier: () => ExperimentalRoutingClassifier,
  onFallback?: (category: string, diagnostic?: string, rawResponse?: string) => void,
  onAllocationRejected?: (diagnostic: AllocationDiagnostic) => void
): Promise<RoutingRecommendation> {
  const baseline = deterministicRoute(input, models);
  if (provider === "deterministic") return baseline;
  try {
    const localRecommendation = await createClassifier().classify(input, models);
    const rejection = allocationRejection(localRecommendation, models);
    if (rejection) {
      onAllocationRejected?.(rejection);
      throw new Error("ModelDeck returned an unsupported allocation.");
    }
    return applyGuardrails(localRecommendation, input, models);
  } catch (error) {
    const fallback = classifyModelDeckFailure(error);
    onFallback?.(fallback, modelDeckFailureDiagnostic(error), modelDeckRawFailureResponse(error));
    return { ...baseline, providerFallback: fallback };
  }
}

export function supportsAllocation(recommendation: RoutingRecommendation, models: CodexModel[]): boolean {
  return allocationRejection(recommendation, models) === undefined;
}

export function allocationRejection(recommendation: RoutingRecommendation, models: readonly CodexModel[]): AllocationDiagnostic | undefined {
  const matches = models.filter((candidate) => candidate.id === recommendation.recommendedModel || candidate.model === recommendation.recommendedModel);
  const model = matches.find((candidate) => !candidate.hidden) ?? matches[0];
  const reason = !model ? "model-not-advertised" : model.hidden ? "model-hidden" : !model.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === recommendation.recommendedEffort) ? "effort-not-supported" : undefined;
  return reason ? { reason, requestedModel: recommendation.recommendedModel, requestedEffort: recommendation.recommendedEffort, supportedEfforts: model && !model.hidden ? model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort) : undefined } : undefined;
}
