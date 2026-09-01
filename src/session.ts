import { AllocationSelection, CodexModel, RoutingRecommendation, RoutingSessionInput, TurnState } from "./contracts";

export type RoutingSessionState = "draft" | "analysing" | "recommendation-ready" | "awaiting-approval" | "running" | "completed" | "failed" | "cancelled";

export interface RoutingContextSummary {
  routing: string;
  execution: string;
}

export interface SessionExecutor {
  execute(prompt: string, selection: AllocationSelection, signal: AbortSignal): Promise<TurnState>;
}

export class RoutingSessionController {
  private currentState: RoutingSessionState = "draft";
  private currentRecommendation?: RoutingRecommendation;
  private currentSelection?: AllocationSelection;
  private readonly cancellation = new AbortController();

  public constructor(
    public readonly input: RoutingSessionInput,
    private readonly recommend: (input: RoutingSessionInput["routing"], models: CodexModel[]) => Promise<RoutingRecommendation>,
    private readonly executor: SessionExecutor
  ) {}

  get state(): RoutingSessionState { return this.currentState; }
  get recommendation(): RoutingRecommendation | undefined { return this.currentRecommendation; }
  get selection(): AllocationSelection | undefined { return this.currentSelection; }

  async analyse(models: CodexModel[]): Promise<RoutingRecommendation> {
    this.requireState("draft");
    this.currentState = "analysing";
    try {
      this.currentRecommendation = await this.recommend(this.input.routing, models);
      this.currentState = "recommendation-ready";
      return this.currentRecommendation;
    } catch (error) {
      this.currentState = "failed";
      throw error;
    }
  }

  awaitApproval(): void {
    this.requireState("recommendation-ready");
    this.currentState = "awaiting-approval";
  }

  acceptRecommendation(): AllocationSelection {
    this.requireState("awaiting-approval");
    const recommendation = this.requireRecommendation();
    this.currentSelection = {
      model: recommendation.recommendedModel,
      effort: recommendation.recommendedEffort,
      overridden: false
    };
    return this.currentSelection;
  }

  override(model: string, effort: string, models: CodexModel[]): AllocationSelection {
    this.requireState("awaiting-approval");
    const selectedModel = models.find((candidate) => !candidate.hidden && (candidate.model === model || candidate.id === model));
    if (!selectedModel) throw new Error("The override model is not selectable in the live App Server catalogue.");
    if (!selectedModel.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === effort)) {
      throw new Error("The override reasoning effort is not supported by the selected live model.");
    }
    this.currentSelection = { model: selectedModel.model, effort, overridden: true };
    return this.currentSelection;
  }

  async execute(): Promise<TurnState> {
    if (this.currentState !== "awaiting-approval" || !this.currentSelection) throw new Error("Explicit acceptance or override is required before execution.");
    this.currentState = "running";
    try {
      const result = await this.executor.execute(buildExecutionPrompt(this.input), this.currentSelection, this.cancellation.signal);
      this.currentState = result;
      return result;
    } catch (error) {
      this.currentState = this.cancellation.signal.aborted ? "cancelled" : "failed";
      throw error;
    }
  }

  cancel(): boolean {
    if (this.currentState !== "running" || this.cancellation.signal.aborted) return false;
    this.cancellation.abort();
    return true;
  }

  contextSummary(): RoutingContextSummary {
    const metadata = this.input.routing.metadata;
    const routingItems = ["task description"];
    if (metadata?.languageId) routingItems.push(`language: ${metadata.languageId}`);
    if (metadata?.relativeFileName) routingItems.push(`file metadata: ${metadata.relativeFileName}`);
    if (metadata?.selectionPresent) routingItems.push(`selection metadata: ${metadata.selectedCharacters ?? 0} characters; source withheld`);
    const excerpt = this.input.execution.selectedExcerpt;
    const proxy = this.input.execution.localProxyCandidate;
    const executionItems = [excerpt ? `task description and approved ${excerpt.content.length}-character selected excerpt` : "task description only"];
    if (proxy) executionItems.push(`advisory ModelDeck proxy candidate from ${proxy.model}`);
    return {
      routing: routingItems.join(", "),
      execution: executionItems.join(", plus ")
    };
  }

  private requireRecommendation(): RoutingRecommendation {
    if (!this.currentRecommendation) throw new Error("No routing recommendation is available.");
    return this.currentRecommendation;
  }

  private requireState(expected: RoutingSessionState): void {
    if (this.currentState !== expected) throw new Error(`Routing session must be ${expected}, not ${this.currentState}.`);
  }
}

export function buildExecutionPrompt(input: RoutingSessionInput): string {
  const task = input.execution.task.trim();
  const excerpt = input.execution.selectedExcerpt;
  const proxy = input.execution.localProxyCandidate;
  const sections = [task];
  if (excerpt) {
    const origin = excerpt.relativeFileName ? ` from ${excerpt.relativeFileName}` : "";
    sections.push(`User-approved selected excerpt${origin}:\n${excerpt.content}`);
  }
  if (proxy) {
    sections.push([
      `Experimental local ModelDeck proxy candidate from ${proxy.model}.`,
      "Review it independently. Apply it only if it is correct; normal Codex approval and verification requirements still apply.",
      `File: ${proxy.file}`,
      `Search:\n${proxy.search}`,
      `Replacement:\n${proxy.replacement}`
    ].join("\n"));
  }
  return sections.join("\n\n");
}
