import * as vscode from "vscode";
import { CodexAppServer, isChatGPTAuthentication } from "./appServer";
import { CodexModel, ReasoningEffort, RoutingInput, RoutingRecommendation } from "./contracts";
import { ModelDeckProvider } from "./modelDeck";
import { OutcomeStore } from "./outcomes";
import { applyGuardrails, fallbackRoute, selectEffort } from "./routing";

let appServer: CodexAppServer | undefined;
let statusItem: vscode.StatusBarItem;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Codex Router");
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = "codexRouter.newRoutedTask";
  setStatus("checking");
  statusItem.show();

  context.subscriptions.push(output, statusItem, {
    dispose: () => appServer?.dispose()
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("codexRouter.newRoutedTask", () => newRoutedTask(context)),
    vscode.commands.registerCommand("codexRouter.routeSelection", () => routeSelection(context))
  );

  if (vscode.chat) {
    const participant = vscode.chat.createChatParticipant("codex-router.router", async (request, _chatContext, stream, token) => {
      await routeAndRun(context, { task: request.prompt }, {
        progress: (message) => stream.progress(message),
        text: (message) => stream.markdown(message),
        cancelled: () => token.isCancellationRequested
      });
      return {};
    });
    participant.iconPath = new vscode.ThemeIcon("compass");
    context.subscriptions.push(participant);
  }

  void refreshStatus();
}

async function newRoutedTask(context: vscode.ExtensionContext): Promise<void> {
  const task = await vscode.window.showInputBox({
    title: "Codex Router: New Routed Task",
    prompt: "Describe the coding task to route to Codex",
    ignoreFocusOut: true
  });
  if (!task?.trim()) return;
  const active = vscode.window.activeTextEditor;
  await routeAndRun(context, {
    task,
    languageId: active?.document.languageId,
    selectedFileName: active ? vscode.workspace.asRelativePath(active.document.uri) : undefined,
    workspaceName: vscode.workspace.name
  }, notificationSink());
}

async function routeSelection(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return;
  const task = await vscode.window.showInputBox({
    title: "Codex Router: Selected Code",
    prompt: "What should Codex do with the selected code?",
    ignoreFocusOut: true
  });
  if (!task?.trim()) return;
  const selected = editor.document.getText(editor.selection).slice(0, 12_000);
  await routeAndRun(context, {
    task: `${task}\n\nSelected excerpt from ${vscode.workspace.asRelativePath(editor.document.uri)}:\n${selected}`,
    languageId: editor.document.languageId,
    selectedFileName: vscode.workspace.asRelativePath(editor.document.uri),
    workspaceName: vscode.workspace.name
  }, notificationSink());
}

async function routeAndRun(context: vscode.ExtensionContext, input: RoutingInput, sink: StreamSink): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    sink.text("Codex Router requires a trusted workspace before it can submit a coding task.");
    return;
  }
  try {
    sink.progress("Checking ChatGPT-authenticated Codex and available models…");
    const server = await getServer();
    const status = await server.start();
    if (!isChatGPTAuthentication(status.authMethod)) {
      setStatus("auth-required");
      sink.text("Codex Router only submits through ChatGPT-authenticated Codex. Run `codex logout`, then `codex login`, and verify with `codex login status`.");
      return;
    }
    if (!status.models.length) throw new Error("Codex App Server reported no available models.");

    const recommendation = await route(input, status.models);
    const choice = await chooseConfiguration(recommendation, status.models);
    if (!choice) return;

    sink.text(formatRecommendation(recommendation, choice.overridden));
    sink.progress(`Starting Codex with ${choice.model} / ${choice.effort}…`);
    setStatus("running", choice.model, choice.effort);
    const startedAt = Date.now();
    const earlyEvents: Array<{ method: string; params: unknown }> = [];
    const bufferEarlyEvent = (method: string, params: unknown) => earlyEvents.push({ method, params });
    server.on("notification", bufferEarlyEvent);
    const { threadId, turnId } = await server.startTurn(input.task, workspacePath(), choice.model, choice.effort);
    server.off("notification", bufferEarlyEvent);
    await streamTurn(server, threadId, turnId, sink, earlyEvents);
    await recordOutcome(context, recommendation, choice, Date.now() - startedAt, "completed");
    setStatus("ready", choice.model, choice.effort);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected routing error.";
    output.appendLine(`[error] ${message}`);
    sink.text(`Codex Router could not complete the task: ${message}`);
    setStatus("error");
  }
}

async function route(input: RoutingInput, models: CodexModel[]): Promise<RoutingRecommendation> {
  const configuration = vscode.workspace.getConfiguration("codexRouter");
  try {
    const provider = new ModelDeckProvider({
      baseUrl: configuration.get<string>("modelDeck.baseUrl", "http://127.0.0.1:8600/v1"),
      routerModel: configuration.get<string>("modelDeck.routerModel", "") || undefined,
      timeoutMs: configuration.get<number>("requestTimeoutMs", 15_000)
    });
    const localRecommendation = await provider.classify(input);
    return applyGuardrails(localRecommendation, input, models);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    output.appendLine(`[router fallback] ${message}`);
    return applyGuardrails(fallbackRoute(input), input, models);
  }
}

async function chooseConfiguration(recommendation: RoutingRecommendation, models: CodexModel[]): Promise<{ model: string; effort: ReasoningEffort; overridden: boolean } | undefined> {
  const use = await vscode.window.showQuickPick([
    { label: `Use recommendation — ${recommendation.recommendedModel} / ${recommendation.recommendedEffort}`, action: "use" },
    { label: "Override model or reasoning effort…", action: "override" }
  ], { title: "Codex Router recommendation", placeHolder: recommendation.reasons.join(" ") });
  if (!use) return undefined;
  if (use.action === "use") return { model: recommendation.recommendedModel, effort: recommendation.recommendedEffort, overridden: false };

  const model = await vscode.window.showQuickPick(models.filter((entry) => !entry.hidden).map((entry) => ({ label: entry.model, description: entry.displayName, model: entry })), { title: "Choose Codex model" });
  if (!model) return undefined;
  const efforts = model.model.supportedReasoningEfforts.map(({ reasoningEffort, description }) => ({ label: reasoningEffort, description }));
  const effort = await vscode.window.showQuickPick(efforts, { title: "Choose reasoning effort" });
  if (!effort) return undefined;
  return { model: model.model.model, effort: effort.label, overridden: true };
}

async function streamTurn(server: CodexAppServer, threadId: string, turnId: string, sink: StreamSink, earlyEvents: Array<{ method: string; params: unknown }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error("Timed out waiting for Codex to finish the turn.")), 20 * 60_000);
    const listener = (method: string, params: unknown): void => {
      const event = params as { threadId?: string; turnId?: string; delta?: string; turn?: { id?: string; status?: string } };
      if (event.threadId !== threadId) return;
      if (method === "item/agentMessage/delta" && event.turnId === turnId && event.delta) sink.text(event.delta);
      if (method === "turn/completed" && event.turn?.id === turnId) finish();
    };
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.off("notification", listener);
      error ? reject(error) : resolve();
    };
    server.on("notification", listener);
    for (const event of earlyEvents) listener(event.method, event.params);
    if (sink.cancelled?.()) finish(new Error("Cancelled."));
  });
}

async function recordOutcome(context: vscode.ExtensionContext, recommendation: RoutingRecommendation, selected: { model: string; effort: ReasoningEffort; overridden: boolean }, durationMs: number, completionStatus: "completed" | "failed" | "cancelled"): Promise<void> {
  if (!vscode.workspace.getConfiguration("codexRouter").get<boolean>("analytics.enabled", false)) return;
  const paths = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  await new OutcomeStore(context.globalStorageUri.fsPath).append({
    timestamp: new Date().toISOString(),
    workspaceId: OutcomeStore.workspaceId(paths),
    taskType: recommendation.taskType,
    recommendation: { recommendedModel: recommendation.recommendedModel, recommendedEffort: recommendation.recommendedEffort, confidence: recommendation.confidence, source: recommendation.source },
    selected,
    durationMs,
    completionStatus,
    validationStatus: "not-observed"
  });
}

async function getServer(): Promise<CodexAppServer> {
  if (!appServer) {
    appServer = new CodexAppServer();
    appServer.on("diagnostic", (message: string) => output.appendLine(`[app-server] ${message}`));
  }
  return appServer;
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await (await getServer()).start();
    setStatus(isChatGPTAuthentication(status.authMethod) ? "ready" : "auth-required");
  } catch {
    setStatus("offline");
  }
}

function workspacePath(): string {
  const path = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!path) throw new Error("Open a workspace folder before submitting a routed task.");
  return path;
}

function formatRecommendation(recommendation: RoutingRecommendation, overridden: boolean): string {
  const origin = recommendation.source === "local-model" ? "local model" : "deterministic fallback";
  return `**Codex Router** — ${recommendation.recommendedModel} / ${recommendation.recommendedEffort}${overridden ? " (overridden)" : ""}\n\n${recommendation.reasons.map((reason) => `- ${reason}`).join("\n")}\n\n_Routing source: ${origin}; confidence: ${Math.round(recommendation.confidence * 100)}%._\n\n`;
}

function setStatus(state: "checking" | "ready" | "running" | "offline" | "auth-required" | "error", model?: string, effort?: ReasoningEffort): void {
  const labels: Record<typeof state, string> = {
    checking: "$(sync~spin) Codex Router: checking",
    ready: `$(compass) Codex Router: ${model && effort ? `${model} / ${effort}` : "ready"}`,
    running: `$(sync~spin) Codex Router: ${model} / ${effort}`,
    offline: "$(warning) Codex Router: App Server unavailable",
    "auth-required": "$(key) Codex Router: ChatGPT login required",
    error: "$(error) Codex Router: error"
  };
  statusItem.text = labels[state];
  statusItem.tooltip = "Codex Router — local routing with ChatGPT-authenticated Codex";
}

interface StreamSink {
  progress: (message: string) => void;
  text: (message: string) => void;
  cancelled?: () => boolean;
}

function notificationSink(): StreamSink {
  output.show(true);
  return {
    progress: (message) => output.appendLine(`[progress] ${message}`),
    text: (message) => output.append(message)
  };
}
