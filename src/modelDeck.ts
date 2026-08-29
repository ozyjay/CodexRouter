import { RoutingInput, RoutingRecommendation } from "./contracts";
import { isValidRecommendation } from "./routing";

export interface ModelDeckConfig {
  baseUrl: string;
  routerModel?: string;
  timeoutMs: number;
}

interface ModelDeckModel {
  id: string;
  ready?: boolean;
}

export class ModelDeckProvider {
  public constructor(private readonly config: ModelDeckConfig) {
    assertLoopbackUrl(config.baseUrl);
  }

  async discoverModels(): Promise<string[]> {
    const response = await this.request("models", { method: "GET" });
    const payload = await response.json() as { data?: ModelDeckModel[] };
    if (!Array.isArray(payload.data)) throw new Error("ModelDeck returned an invalid /models response.");
    return payload.data.filter((model) => model.ready !== false).map((model) => model.id).filter(Boolean);
  }

  async classify(input: RoutingInput): Promise<RoutingRecommendation> {
    const discovered = await this.discoverModels();
    const model = this.config.routerModel || discovered[0];
    if (!model) throw new Error("ModelDeck did not report a ready local routing model.");

    const response = await this.request("chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        messages: [
          { role: "system", content: ROUTER_PROMPT },
          { role: "user", content: JSON.stringify({ task: input.task, languageId: input.languageId, selectedFileName: input.selectedFileName, workspaceName: input.workspaceName }) }
        ]
      })
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("ModelDeck returned no chat-completion content.");

    const candidate = parseJsonObject(content);
    if (!isValidRecommendation(candidate)) throw new Error("ModelDeck returned an invalid routing recommendation.");
    return { ...candidate, source: "local-model" };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/${path}`, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`ModelDeck request failed with HTTP ${response.status}.`);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
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
