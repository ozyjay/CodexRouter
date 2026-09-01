import { MODELDECK_POLICY_VERSION, ProviderFallback, RoutingInput, RoutingRecommendation } from "./contracts";
import { SimulationProfile } from "./evaluation";
import { fallbackRoute, isValidRecommendation } from "./routing";

export interface ModelDeckConfig {
  baseUrl: string;
  routerModel?: string;
  timeoutMs: number;
  proxyMaxTokens?: number;
}

interface ModelDeckModel {
  id: string;
  ready?: boolean;
  revision?: string;
  modeldeck?: { model_id?: string; configuration_fingerprint?: string };
}

export interface ModelDeckRouteIdentity {
  publicModelId: string;
  localModelId?: string;
  revision?: string;
  configurationFingerprint?: string;
}

export interface ModelDeckReadinessPreflight {
  modelIds: string[];
  readyAfterMs: number;
  consecutiveReadyChecks: number;
}

export interface SimulationSelectorInput {
  task: string;
  taskCategory: string;
  estimatedFilesAffected: number;
  testsRequested: boolean;
  riskFlags: string[];
}

export interface SimulationSelectorRecommendation {
  simulationProfile: SimulationProfile;
  confidence: number;
  rationale: string;
  model: ModelDeckRouteIdentity;
}

export interface ProxyCandidateInput {
  task: string;
  allowedFiles: string[];
  context: Array<{ file: string; content: string }>;
  maxPatches: number;
}

export interface ProxyCandidate {
  patches: Array<{ file: string; search: string; replacement: string }>;
  model: ModelDeckRouteIdentity;
}

export type ProxyCandidateRejectionReason = "empty-response" | "invalid-json" | "invalid-contract";

export class ProxyCandidateError extends Error {
  public constructor(public readonly reason: ProxyCandidateRejectionReason) {
    super(`ModelDeck proxy candidate rejected: ${reason}.`);
  }
}

export class ModelDeckProvider {
  public constructor(private readonly config: ModelDeckConfig) {
    assertLoopbackUrl(config.baseUrl);
  }

  async discoverModels(): Promise<string[]> {
    return (await this.discoverReadyModels()).map((model) => model.id);
  }

  async snapshotRoutes(modelIds: readonly string[]): Promise<Record<string, ModelDeckRouteIdentity>> {
    const response = await this.request("models", { method: "GET" });
    const payload = await response.json() as { data?: ModelDeckModel[] };
    if (!Array.isArray(payload.data)) throw new Error("ModelDeck returned an invalid /models response.");
    const snapshot: Record<string, ModelDeckRouteIdentity> = {};
    for (const modelId of [...new Set(modelIds)]) {
      const model = payload.data.find((candidate) => candidate.id === modelId);
      if (!model) throw new Error(`ModelDeck did not report configured route ${modelId}.`);
      snapshot[modelId] = modelDeckRouteIdentity(modelId, model);
    }
    return snapshot;
  }

  async waitForReadyModels(modelIds: readonly string[], options: { timeoutMs: number; pollIntervalMs: number; consecutiveReadyChecks: number }, pause: (milliseconds: number) => Promise<void> = wait): Promise<ModelDeckReadinessPreflight> {
    const uniqueModelIds = [...new Set(modelIds)];
    if (uniqueModelIds.length === 0) return { modelIds: [], readyAfterMs: 0, consecutiveReadyChecks: 0 };
    const startedAt = Date.now();
    let readyChecks = 0;
    while (true) {
      const readyModelIds = new Set((await this.discoverReadyModels()).map((model) => model.id));
      readyChecks = uniqueModelIds.every((modelId) => readyModelIds.has(modelId)) ? readyChecks + 1 : 0;
      if (readyChecks >= options.consecutiveReadyChecks) {
        return { modelIds: uniqueModelIds, readyAfterMs: Date.now() - startedAt, consecutiveReadyChecks: readyChecks };
      }
      const remainingMs = options.timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw new Error("ModelDeck proxy readiness preflight timed out.");
      await pause(Math.min(options.pollIntervalMs, remainingMs));
    }
  }

  async classify(input: RoutingInput): Promise<RoutingRecommendation> {
    const discovered = await this.discoverReadyModels();
    const model = this.config.routerModel || discovered[0]?.id;
    if (!model) throw new Error("ModelDeck did not report a ready local routing model.");
    const selectedModel = discovered.find((candidate) => candidate.id === model);
    if (!selectedModel) throw new Error("The configured ModelDeck routing model is not ready.");

    const response = await this.request("chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        max_tokens: 512,
        messages: [
          { role: "system", content: ROUTER_PROMPT },
          { role: "user", content: JSON.stringify(input) }
        ]
      })
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("ModelDeck returned no chat-completion content.");

    let candidate: unknown;
    try { candidate = parseJsonObject(content); } catch { throw new Error("ModelDeck returned malformed routing JSON."); }
    if (!isValidRecommendation(candidate)) throw new Error("ModelDeck returned an invalid routing recommendation.");
    const baseline = fallbackRoute(input);
    return {
      ...candidate,
      source: "local-model",
      strength: baseline.strength,
      policyVersion: MODELDECK_POLICY_VERSION,
      assessment: baseline.assessment,
      classifierModel: modelDeckRouteIdentity(model, selectedModel).publicModelId
    };
  }

  async selectSimulationProfile(input: SimulationSelectorInput): Promise<SimulationSelectorRecommendation> {
    const discovered = await this.discoverReadyModels();
    const model = this.config.routerModel || discovered[0]?.id;
    if (!model) throw new Error("ModelDeck did not report a ready local simulation selector.");
    const selectedModel = discovered.find((candidate) => candidate.id === model);
    if (!selectedModel) throw new Error("The configured ModelDeck simulation selector is not ready.");

    const response = await this.request("chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        max_tokens: 128,
        messages: [
          { role: "system", content: SIMULATION_SELECTOR_PROMPT },
          { role: "user", content: JSON.stringify(input) }
        ]
      })
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("ModelDeck returned no simulation-selector content.");
    const candidate = parseJsonObject(content);
    if (!isValidSimulationSelectorRecommendation(candidate)) throw new Error("ModelDeck returned an invalid simulation-selector response.");
    return {
      ...candidate,
      model: modelDeckRouteIdentity(model, selectedModel)
    };
  }

  async generateProxyCandidate(model: string, input: ProxyCandidateInput, maxTokens = this.config.proxyMaxTokens ?? 2_048): Promise<ProxyCandidate> {
    if (!isValidProxyCandidateInput(input)) throw new Error("Invalid constrained proxy-candidate input.");
    const discovered = await this.discoverReadyModels();
    const selectedModel = discovered.find((candidate) => candidate.id === model);
    if (!selectedModel) throw new Error("The configured ModelDeck proxy model is not ready.");
    const response = await this.request("chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: PROXY_CANDIDATE_PROMPT },
          { role: "user", content: JSON.stringify(input) }
        ]
      })
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) throw new ProxyCandidateError("empty-response");
    const candidate = parseProxyCandidateJson(content);
    if (!isValidProxyCandidate(candidate, input)) throw new ProxyCandidateError("invalid-contract");
    return {
      patches: candidate.patches,
      model: modelDeckRouteIdentity(model, selectedModel)
    };
  }

  private async discoverReadyModels(): Promise<ModelDeckModel[]> {
    const response = await this.request("models", { method: "GET" });
    const payload = await response.json() as { data?: ModelDeckModel[] };
    if (!Array.isArray(payload.data)) throw new Error("ModelDeck returned an invalid /models response.");
    return payload.data.filter((model) => model.ready !== false && typeof model.id === "string" && model.id.length > 0);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/${path}`, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`ModelDeck request failed with HTTP ${response.status}.`);
      return response;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("ModelDeck request timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function classifyModelDeckFailure(error: unknown): ProviderFallback {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out")) return "timeout";
  if (message.includes("no ready") || message.includes("not ready") || message.includes("a ready local routing model")) return "no-ready-model";
  if (message.includes("invalid") || message.includes("malformed") || message.includes("json") || message.includes("content")) return "malformed";
  if (message.includes("unsupported") || message.includes("unavailable model")) return "unsupported-allocation";
  return "unavailable";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function modelDeckRouteIdentity(publicModelId: string, model: ModelDeckModel): ModelDeckRouteIdentity {
  const identity: ModelDeckRouteIdentity = { publicModelId };
  if (model.modeldeck?.model_id) identity.localModelId = model.modeldeck.model_id;
  if (model.revision) identity.revision = model.revision;
  if (model.modeldeck?.configuration_fingerprint) identity.configurationFingerprint = model.modeldeck.configuration_fingerprint;
  return identity;
}

export function assertLoopbackUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ModelDeck URL must be a valid loopback HTTP(S) URL.");
  }
  const host = url.hostname.toLowerCase();
  if (!["127.0.0.1", "::1"].includes(host)) {
    throw new Error("Codex Router only permits loopback ModelDeck endpoints.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("ModelDeck URL must use HTTP or HTTPS.");
}

function parseJsonObject(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? content;
  return JSON.parse(fenced.trim());
}

function parseProxyCandidateJson(content: string): unknown {
  const withoutThinking = content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "");
  try {
    return parseJsonObject(withoutThinking);
  } catch {
    throw new ProxyCandidateError("invalid-json");
  }
}

function isValidSimulationSelectorRecommendation(value: unknown): value is Omit<SimulationSelectorRecommendation, "model"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expected = ["simulationProfile", "confidence", "rationale"];
  if (Object.keys(candidate).length !== expected.length || !expected.every((key) => key in candidate)) return false;
  return ["sim-small", "sim-balanced", "sim-strong"].includes(candidate.simulationProfile as string)
    && typeof candidate.confidence === "number"
    && Number.isFinite(candidate.confidence)
    && candidate.confidence >= 0
    && candidate.confidence <= 1
    && typeof candidate.rationale === "string"
    && candidate.rationale.trim().length > 0
    && candidate.rationale.length <= 160
    && !/[\r\n]/.test(candidate.rationale);
}

function isValidProxyCandidateInput(value: ProxyCandidateInput): boolean {
  return typeof value.task === "string"
    && value.task.trim().length > 0
    && Array.isArray(value.allowedFiles)
    && value.allowedFiles.length > 0
    && value.allowedFiles.every(isSafeRelativeFile)
    && new Set(value.allowedFiles).size === value.allowedFiles.length
    && Array.isArray(value.context)
    && value.context.length > 0
    && value.context.every((entry) => isRecord(entry) && value.allowedFiles.includes(entry.file as string) && typeof entry.content === "string")
    && Number.isInteger(value.maxPatches)
    && value.maxPatches >= 1
    && value.maxPatches <= 8;
}

function isValidProxyCandidate(value: unknown, input: ProxyCandidateInput): value is { patches: Array<{ file: string; search: string; replacement: string }> } {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.patches) || value.patches.length < 1 || value.patches.length > input.maxPatches) return false;
  const contextFiles = new Set(input.context.map((entry) => entry.file));
  const files = new Set<string>();
  return value.patches.every((patch) => {
    if (!isRecord(patch) || Object.keys(patch).length !== 3 || !isSafeRelativeFile(patch.file) || !input.allowedFiles.includes(patch.file) || !contextFiles.has(patch.file) || files.has(patch.file)) return false;
    files.add(patch.file);
    return typeof patch.search === "string" && patch.search.length > 0 && patch.search.length <= 12_000
      && typeof patch.replacement === "string" && patch.replacement.length <= 16_000;
  });
}

function isSafeRelativeFile(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.startsWith("/") && !value.split("/").includes("..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROUTER_PROMPT = `You are a local task-routing classifier. Return only one JSON object with exactly these fields:
taskType: implementation|debugging|documentation|testing|refactor|other;
scope: narrow|medium|broad;
complexity: low|moderate|high;
risk: normal|elevated|high;
ambiguity: low|medium|high;
recommendedModel: a Codex model ID recommendation;
recommendedEffort: a reasoning effort string;
confidence: number from 0 to 1;
reasons: array of at most 3 concise strings, each under 240 characters;
escalationSignals: array of at most 4 concise strings.
You provide advice only. Do not include source code, credentials, repository content, markdown, or prose outside the JSON object.`;

const SIMULATION_SELECTOR_PROMPT = `You are a local simulation-tier selector for a deterministic evaluation harness. Return only one JSON object with exactly these fields:
simulationProfile: sim-small|sim-balanced|sim-strong;
confidence: number from 0 to 1;
rationale: a concise explanation of at most 160 characters.
Choose sim-small for focused, low-risk work; sim-balanced for ordinary bounded changes; sim-strong for ambiguous, broad, destructive, security-sensitive, or high-risk work. You select a declared deterministic scenario only. Do not propose commands, patches, source code, paths, credentials, Markdown, or prose outside the JSON object.`;

const PROXY_CANDIDATE_PROMPT = `You are a constrained local proxy in an evaluation harness. Return only one JSON object with exactly this field:
patches: an array of one to the supplied maximum number of patch objects.
Every patch object must have exactly these fields:
file: one of the supplied allowedFiles;
search: an exact non-empty unique text fragment from that file's supplied context;
replacement: replacement text for the first occurrence only.
Use only the supplied task and context. Do not add files, commands, explanations, Markdown, credentials, paths outside allowedFiles, or prose outside the JSON object. If the requested change cannot be made safely from the supplied context, return {"patches":[]}.`;
