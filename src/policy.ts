import { CodexModel, RoutingInput, RoutingProvider, RoutingRecommendation } from "./contracts";
import { classifyModelDeckFailure, modelDeckFailureDiagnostic, modelDeckRawFailureResponse } from "./modelDeck";
import { applyGuardrails, deterministicRoute } from "./routing";

export interface ExperimentalRoutingClassifier {
  classify(input: RoutingInput): Promise<RoutingRecommendation>;
}

export async function recommendWithProvider(
  input: RoutingInput,
  models: CodexModel[],
  provider: RoutingProvider,
  createClassifier: () => ExperimentalRoutingClassifier,
  onFallback?: (category: string, diagnostic?: string, rawResponse?: string) => void
): Promise<RoutingRecommendation> {
  const baseline = deterministicRoute(input, models);
  if (provider === "deterministic") return baseline;
  try {
    const localRecommendation = await createClassifier().classify(input);
    if (!supportsAllocation(localRecommendation, models)) throw new Error("ModelDeck returned an unsupported allocation.");
    return applyGuardrails(localRecommendation, input, models);
  } catch (error) {
    const fallback = classifyModelDeckFailure(error);
    onFallback?.(fallback, modelDeckFailureDiagnostic(error), modelDeckRawFailureResponse(error));
    return { ...baseline, providerFallback: fallback };
  }
}

export function supportsAllocation(recommendation: RoutingRecommendation, models: CodexModel[]): boolean {
  const model = models.find((candidate) => !candidate.hidden && (candidate.id === recommendation.recommendedModel || candidate.model === recommendation.recommendedModel));
  return Boolean(model?.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === recommendation.recommendedEffort));
}
