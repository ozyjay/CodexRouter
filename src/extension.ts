import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { CodexAppServer, isChatGPTAuthentication } from "./appServer";
import { AllocationSelection, CodexModel, OUTCOME_SCHEMA_VERSION, ReasoningEffort, RoutingInput, RoutingProvider, RoutingRecommendation, RoutingSessionInput, TurnState } from "./contracts";
import { ModelDeckProvider, ProxyCandidateError, assertModelDeckModelId, classifyModelDeckFailure } from "./modelDeck";
import { OutcomeStore, renderOutcomeMarkdown } from "./outcomes";
import { recommendWithProvider } from "./policy";
import { prepareSelectionProxyCandidate, renderProxyCandidateMarkdown } from "./proxy";
import { RoutingSessionController } from "./session";
import { StreamTokenEstimator, StreamThroughput } from "./streamMetrics";

let appServer: CodexAppServer | undefined;
let activeSession: RoutingSessionController | undefined;
let statusItem: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let resultProvider: RouterResultProvider;
let sidebarProvider: RouterSidebarProvider;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Codex Router");
  resultProvider = new RouterResultProvider();
  sidebarProvider = new RouterSidebarProvider(context);
  output.appendLine("Codex Router activated.");
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  setStatus("checking");
  statusItem.show();

  context.subscriptions.push(
    output,
    statusItem,
    resultProvider,
    vscode.window.registerWebviewViewProvider(RouterSidebarProvider.viewType, sidebarProvider),
    vscode.workspace.registerTextDocumentContentProvider(RouterResultProvider.scheme, resultProvider),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === RouterResultProvider.scheme) resultProvider.remove(document.uri);
    }),
    { dispose: () => appServer?.dispose() }
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("codexRouter.newRoutedTask", () => newRoutedTask(context)),
    vscode.commands.registerCommand("codexRouter.routeSelection", () => routeSelection(context)),
    vscode.commands.registerCommand("codexRouter.generateProxyCandidate", () => generateProxyCandidate(context)),
    vscode.commands.registerCommand("codexRouter.cancelActiveTurn", () => cancelActiveTurn()),
    vscode.commands.registerCommand("codexRouter.exportOutcomes", () => exportOutcomes(context)),
    vscode.commands.registerCommand("codexRouter.clearOutcomes", () => clearOutcomes(context)),
    vscode.commands.registerCommand("codexRouter.showDiagnostics", () => showDiagnostics())
  );

  if (vscode.chat) {
    const participant = vscode.chat.createChatParticipant("codex-router.router", async (request, _chatContext, stream, token) => {
      await routeAndRun(context, sessionInput(request.prompt), {
        progress: (message) => stream.progress(message),
        text: (message) => stream.markdown(message),
        onCancellationRequested: (listener) => token.onCancellationRequested(listener)
      });
      return {};
    });
    participant.iconPath = new vscode.ThemeIcon("compass");
    context.subscriptions.push(participant);
    output.appendLine("Registered the @router chat participant.");
  } else {
    output.appendLine("VS Code Chat Participant API is unavailable; use the New Routed Task command.");
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
  let includeMetadata = false;
  if (active) {
    const contextChoice = await vscode.window.showQuickPick([
      { label: "Task description only", include: false, description: "No active-file metadata is used for routing" },
      { label: "Include active-file metadata", include: true, description: "Share language and relative filename, but no source code" }
    ], { title: "Choose limited routing context" });
    if (!contextChoice) return;
    includeMetadata = contextChoice.include;
  }
  const input = sessionInput(task, includeMetadata && active ? {
    languageId: active.document.languageId,
    relativeFileName: vscode.workspace.asRelativePath(active.document.uri),
    workspaceFolderCount: vscode.workspace.workspaceFolders?.length
  } : undefined);
  await routeAndRun(context, input, notificationSink());
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
  const relativeFileName = vscode.workspace.asRelativePath(editor.document.uri);
  await routeAndRun(context, {
    routing: {
      task,
      metadata: {
        languageId: editor.document.languageId,
        relativeFileName,
        workspaceFolderCount: vscode.workspace.workspaceFolders?.length,
        selectionPresent: true,
        selectedCharacters: selected.length
      }
    },
    execution: {
      task,
      selectedExcerpt: { content: selected, relativeFileName, languageId: editor.document.languageId }
    }
  }, notificationSink());
}

async function generateProxyCandidate(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Codex Router requires a trusted workspace before it can send selected code to ModelDeck.");
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return;
  if (!vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
    void vscode.window.showWarningMessage("Select code from a file inside the open workspace before using the ModelDeck proxy.");
    return;
  }
  const selected = editor.document.getText(editor.selection);
  if (selected.length > 12_000) {
    void vscode.window.showWarningMessage("The ModelDeck proxy accepts at most 12,000 selected characters. Narrow the selection and try again.");
    return;
  }
  const task = await vscode.window.showInputBox({
    title: "Codex Router: ModelDeck Proxy Candidate",
    prompt: "Describe the change to propose for the selected code",
    ignoreFocusOut: true,
    validateInput: (value) => value.length > 4_000 ? "Keep the task description to 4,000 characters or fewer." : undefined
  });
  if (!task?.trim()) return;

  const configuration = vscode.workspace.getConfiguration("codexRouter");
  const model = configuration.get<string>("modelDeck.proxyModel", "codex-router-proxy-balanced").trim();
  if (!model) {
    void vscode.window.showWarningMessage("Configure codexRouter.modelDeck.proxyModel before generating a proxy candidate.");
    return;
  }
  let provider: ModelDeckProvider;
  try {
    assertModelDeckModelId(model);
    provider = new ModelDeckProvider({
      baseUrl: configuration.get<string>("modelDeck.baseUrl", "http://127.0.0.1:8600/v1"),
      timeoutMs: configuration.get<number>("modelDeck.proxyTimeoutMs", 120_000),
      proxyMaxTokens: configuration.get<number>("modelDeck.proxyMaxTokens", 2_048)
    });
  } catch {
    void vscode.window.showWarningMessage("The configured ModelDeck endpoint is invalid. Codex Router permits only literal loopback addresses.");
    return;
  }

  const relativeFileName = vscode.workspace.asRelativePath(editor.document.uri).replace(/\\/g, "/");
  const confirmation = await vscode.window.showWarningMessage(
    `Send the task and ${selected.length} selected characters from ${relativeFileName} to the loopback ModelDeck model ${model}? No workspace change or Codex turn starts at this step.`,
    { modal: true },
    "Generate candidate"
  );
  if (confirmation !== "Generate candidate") return;

  const sink = notificationSink();
  sink.progress(`Generating a constrained candidate with ${model}…`);
  try {
    const generated = await provider.generateProxyCandidate(model, {
      task: task.trim(),
      allowedFiles: [relativeFileName],
      context: [{ file: relativeFileName, content: selected }],
      maxPatches: 1
    });
    const candidate = prepareSelectionProxyCandidate(generated, relativeFileName, selected);
    sink.text(renderProxyCandidateMarkdown(candidate));
    const action = await vscode.window.showInformationMessage(
      "ModelDeck generated an advisory candidate. Review the preview before routing it through Codex.",
      "Route candidate through Codex"
    );
    if (action !== "Route candidate through Codex") return;
    await routeAndRun(context, {
      routing: {
        task: task.trim(),
        metadata: {
          languageId: editor.document.languageId,
          relativeFileName,
          workspaceFolderCount: vscode.workspace.workspaceFolders?.length,
          selectionPresent: true,
          selectedCharacters: selected.length
        }
      },
      execution: {
        task: task.trim(),
        selectedExcerpt: { content: selected, relativeFileName, languageId: editor.document.languageId },
        localProxyCandidate: candidate
      }
    }, sink);
  } catch (error) {
    const reason = error instanceof ProxyCandidateError ? error.reason : classifyModelDeckFailure(error);
    output.appendLine(`[proxy candidate] rejected: ${reason}`);
    sink.text(`ModelDeck could not provide a usable proxy candidate (${reason}). No workspace change or Codex turn was started.`);
  }
}

async function routeAndRun(context: vscode.ExtensionContext, input: RoutingSessionInput, sink: StreamSink): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    sink.text("Codex Router requires a trusted workspace before it can submit a coding task.");
    return;
  }

  let session: RoutingSessionController | undefined;
  let startedAt: number | undefined;
  let turnState: TurnState | undefined;
  let outcomeRecorded = false;
  let cancellationDisposable: vscode.Disposable | undefined;
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

    session = new RoutingSessionController(input, (routingInput, models) => route(routingInput, models), {
      execute: (prompt, selection, signal) => executeTurn(server, prompt, selection, signal, sink)
    });
    const summaries = session.contextSummary();
    sink.text(`**Context preview**\n\nRouting: ${summaries.routing}.\n\nCodex execution: ${summaries.execution}.\n\n`);
    const recommendation = await session.analyse(status.models);
    session.awaitApproval();
    sink.activity?.("awaiting-approval", "Choose the recommended configuration or set an override to start Codex.");
    sink.text(formatRecommendation(recommendation, summaries.routing, summaries.execution));
    const choice = await (sink.chooseConfiguration ?? chooseConfiguration)(session, recommendation, status.models);
    if (!choice) return;

    sink.progress(`Starting Codex with ${choice.model} / ${choice.effort}…`);
    sink.activity?.("starting", `Starting Codex with ${choice.model} / ${choice.effort}…`);
    setStatus("running", choice.model, choice.effort);
    activeSession = session;
    cancellationDisposable = sink.onCancellationRequested?.(() => session?.cancel());
    startedAt = Date.now();
    turnState = await session.execute();
    sink.text(turnState === "completed" ? "\n\nCodex turn completed.\n" : turnState === "cancelled" ? "\n\nCodex turn cancelled.\n" : "\n\nCodex turn failed.\n");
    setStatus("ready", choice.model, choice.effort);
    outcomeRecorded = true;
    await safeRecordOutcome(context, recommendation, choice, Date.now() - startedAt, turnState, input.execution.localProxyCandidate?.model);
  } catch (error) {
    const cancelled = session?.state === "cancelled";
    const message = error instanceof Error ? error.message : "Unexpected routing error.";
    output.appendLine(`[error] ${message}`);
    sink.text(cancelled ? "Codex Router cancelled the active turn." : `Codex Router could not complete the task: ${message}`);
    setStatus(cancelled ? "ready" : "error");
    if (!outcomeRecorded && session?.recommendation && session.selection && startedAt !== undefined) {
      turnState = cancelled ? "cancelled" : "failed";
      outcomeRecorded = true;
      await safeRecordOutcome(context, session.recommendation, session.selection, Date.now() - startedAt, turnState, input.execution.localProxyCandidate?.model);
    }
  } finally {
    cancellationDisposable?.dispose();
    if (activeSession === session) activeSession = undefined;
    sink.finish?.();
  }
}

async function route(input: RoutingInput, models: CodexModel[]): Promise<RoutingRecommendation> {
  const configuration = vscode.workspace.getConfiguration("codexRouter");
  const provider = configuration.get<RoutingProvider>("routing.provider", "deterministic");
  return recommendWithProvider(input, models, provider, () => new ModelDeckProvider({
      baseUrl: configuration.get<string>("modelDeck.baseUrl", "http://127.0.0.1:8600/v1"),
      routerModel: configuration.get<string>("modelDeck.routerModel", "") || undefined,
      timeoutMs: configuration.get<number>("requestTimeoutMs", 5_000)
    }), (fallback) => output.appendLine(`[router fallback] ${fallback}`));
}

async function chooseConfiguration(session: RoutingSessionController, recommendation: RoutingRecommendation, models: CodexModel[]): Promise<AllocationSelection | undefined> {
  const use = await vscode.window.showQuickPick([
    { label: `Use recommendation — ${recommendation.recommendedModel} / ${recommendation.recommendedEffort}`, action: "use" },
    { label: "Override model or reasoning effort…", action: "override" }
  ], { title: "Codex Router recommendation", placeHolder: recommendation.reasons.join(" ") });
  if (!use) return undefined;
  if (use.action === "use") return session.acceptRecommendation();

  const model = await vscode.window.showQuickPick(models.filter((entry) => !entry.hidden).map((entry) => ({ label: entry.model, description: entry.displayName, model: entry })), { title: "Choose Codex model" });
  if (!model) return undefined;
  const effort = await vscode.window.showQuickPick(model.model.supportedReasoningEfforts.map(({ reasoningEffort, description }) => ({ label: reasoningEffort, description })), { title: "Choose reasoning effort" });
  if (!effort) return undefined;
  return session.override(model.model.model, effort.label, models);
}

async function executeTurn(server: CodexAppServer, prompt: string, selection: AllocationSelection, signal: AbortSignal, sink: StreamSink): Promise<TurnState> {
  const earlyEvents: Array<{ method: string; params: unknown }> = [];
  const bufferEarlyEvent = (method: string, params: unknown) => earlyEvents.push({ method, params });
  server.on("notification", bufferEarlyEvent);
  const { threadId, turnId } = await server.startTurn(prompt, workspacePath(), selection.model, selection.effort);
  server.off("notification", bufferEarlyEvent);
  sink.activity?.("running", `Codex is working with ${selection.model} / ${selection.effort}.`);

  let interruptRequested = false;
  const interrupt = (): void => {
    if (interruptRequested) return;
    interruptRequested = true;
    sink.progress("Cancelling the active Codex turn…");
    void server.interruptTurn(threadId, turnId).catch((error: unknown) => output.appendLine(`[cancel error] ${error instanceof Error ? error.message : "Unable to interrupt turn."}`));
  };
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  try {
    return await streamTurn(server, threadId, turnId, sink, earlyEvents);
  } finally {
    signal.removeEventListener("abort", interrupt);
  }
}

async function streamTurn(server: CodexAppServer, threadId: string, turnId: string, sink: StreamSink, earlyEvents: Array<{ method: string; params: unknown }>): Promise<TurnState> {
  return new Promise<TurnState>((resolve, reject) => {
    let done = false;
    const tokenEstimator = new StreamTokenEstimator();
    const timer = setTimeout(() => {
      void server.interruptTurn(threadId, turnId).catch(() => undefined);
      finish(undefined, new Error("Timed out waiting for Codex to finish the turn."));
    }, 20 * 60_000);
    const listener = (method: string, params: unknown): void => {
      const event = params as { threadId?: string; turnId?: string; delta?: string; turn?: { id?: string; status?: string } };
      if (event.threadId !== threadId) return;
      if (method === "item/agentMessage/delta" && event.turnId === turnId && event.delta) {
        sink.text(event.delta);
        sink.throughput?.(tokenEstimator.observe(event.delta));
      }
      if (method === "turn/completed" && event.turn?.id === turnId) {
        const state: TurnState = event.turn.status === "interrupted" ? "cancelled" : event.turn.status === "failed" ? "failed" : "completed";
        finish(state);
      }
    };
    const stopped = (error: Error): void => finish(undefined, error);
    const finish = (state?: TurnState, error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.off("notification", listener);
      server.off("stopped", stopped);
      error ? reject(error) : resolve(state ?? "failed");
    };
    server.on("notification", listener);
    server.on("stopped", stopped);
    for (const event of earlyEvents) listener(event.method, event.params);
  });
}

async function recordOutcome(context: vscode.ExtensionContext, recommendation: RoutingRecommendation, selected: AllocationSelection, durationMs: number, turnState: TurnState, localProxyModel?: string): Promise<void> {
  if (!vscode.workspace.getConfiguration("codexRouter").get<boolean>("analytics.enabled", false)) return;
  const feedback = await collectOutcomeFeedback();
  const paths = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  await new OutcomeStore(context.globalStorageUri.fsPath).append({
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    recordId: randomUUID(),
    timestamp: new Date().toISOString(),
    workspaceId: OutcomeStore.workspaceId(paths),
    policyVersion: recommendation.policyVersion,
    taskType: recommendation.taskType,
    routingSource: recommendation.source,
    classifierModel: recommendation.classifierModel,
    recommendationStrength: recommendation.strength,
    recommendation: { recommendedModel: recommendation.recommendedModel, recommendedEffort: recommendation.recommendedEffort },
    selected,
    durationMs,
    turnState,
    ...feedback,
    catalogueFallback: recommendation.catalogueFallback?.reason,
    providerFallback: recommendation.providerFallback,
    localProxyModel
  });
}

async function safeRecordOutcome(context: vscode.ExtensionContext, recommendation: RoutingRecommendation, selected: AllocationSelection, durationMs: number, turnState: TurnState, localProxyModel?: string): Promise<void> {
  try { await recordOutcome(context, recommendation, selected, durationMs, turnState, localProxyModel); }
  catch {
    output.appendLine("[outcome error] Unable to store the local privacy-safe outcome record.");
    void vscode.window.showWarningMessage("Codex Router could not store the local outcome record. The Codex turn result is unaffected.");
  }
}

async function collectOutcomeFeedback(): Promise<Pick<import("./contracts").OutcomeRecord, "taskOutcome" | "validationStatus" | "repairTurns" | "allocationJudgement">> {
  const unreported = { taskOutcome: "unreported", validationStatus: "unreported", allocationJudgement: "unreported" } as const;
  const taskOutcome = await vscode.window.showQuickPick(["completed", "incomplete", "failed"].map((value) => ({ label: value })), { title: "How did the software task finish?", placeHolder: "Escape to leave outcome unreported" });
  if (!taskOutcome) return unreported;
  const validation = await vscode.window.showQuickPick(["passed", "failed", "not-run", "not-observed"].map((value) => ({ label: value })), { title: "What was the build or test result?" });
  const judgement = await vscode.window.showQuickPick(["appropriate", "under-powered", "over-powered", "unsure"].map((value) => ({ label: value })), { title: "Was the selected allocation appropriate?" });
  const repairs = await vscode.window.showInputBox({ title: "Repair turns", prompt: "Optional number of additional repair turns", validateInput: validateRepairTurns });
  return {
    taskOutcome: taskOutcome.label as "completed" | "incomplete" | "failed",
    validationStatus: (validation?.label ?? "unreported") as "passed" | "failed" | "not-run" | "not-observed" | "unreported",
    allocationJudgement: (judgement?.label ?? "unreported") as "appropriate" | "under-powered" | "over-powered" | "unsure" | "unreported",
    repairTurns: repairs?.trim() ? Number(repairs) : undefined
  };
}

function validateRepairTurns(value: string): string | undefined {
  return !value.trim() || /^\d+$/.test(value.trim()) ? undefined : "Enter a non-negative whole number or leave blank.";
}

async function exportOutcomes(context: vscode.ExtensionContext): Promise<void> {
  const records = await new OutcomeStore(context.globalStorageUri.fsPath).readAll();
  if (records.length === 0) {
    void vscode.window.showInformationMessage("Codex Router has no local outcome records to export.");
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: "Export privacy-safe Codex Router outcomes",
    filters: { Markdown: ["md"] },
    saveLabel: "Export outcome report"
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(renderOutcomeMarkdown(records), "utf8"));
  void vscode.window.showInformationMessage(`Exported ${records.length} privacy-safe outcome records.`);
}

async function clearOutcomes(context: vscode.ExtensionContext): Promise<void> {
  const confirmation = await vscode.window.showWarningMessage("Delete all local Codex Router outcome records? This cannot be undone.", { modal: true }, "Delete local records");
  if (confirmation !== "Delete local records") return;
  await new OutcomeStore(context.globalStorageUri.fsPath).clear();
  void vscode.window.showInformationMessage("Deleted local Codex Router outcome records.");
}

function cancelActiveTurn(): void {
  if (!activeSession?.cancel()) void vscode.window.showInformationMessage("Codex Router has no cancellable active turn.");
}

async function getServer(): Promise<CodexAppServer> {
  if (!appServer) {
    appServer = new CodexAppServer();
    appServer.on("diagnostic", (message: string) => output.appendLine(`[app-server] ${message}`));
    appServer.on("request", (id: number | string, method: string, params: unknown) => { void handleServerRequest(appServer!, id, method, params); });
  }
  return appServer;
}

async function handleServerRequest(server: CodexAppServer, id: number | string, method: string, params: unknown): Promise<void> {
  if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") {
    output.appendLine(`[approval] Unsupported App Server request: ${method}.`);
    server.respond(id, undefined, { code: -32601, message: "Codex Router does not support this App Server request." });
    return;
  }
  const details = params as { command?: string | null; reason?: string | null; availableDecisions?: unknown[] | null };
  const action = method.includes("commandExecution") ? "command execution" : "file change";
  const detail = [details.reason, details.command].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n\n");
  const available = new Set((details.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"]).filter((decision): decision is string => typeof decision === "string"));
  const actions = [
    available.has("accept") ? "Approve once" : undefined,
    available.has("acceptForSession") ? "Approve for session" : undefined,
    available.has("decline") ? "Decline" : undefined,
    available.has("cancel") ? "Cancel turn" : undefined
  ].filter((value): value is string => Boolean(value));
  if (actions.length === 0) {
    server.respond(id, undefined, { code: -32602, message: "Codex Router cannot represent the advertised approval decisions." });
    return;
  }
  const choice = await vscode.window.showWarningMessage(`Codex requests approval for ${action}.${detail ? `\n\n${detail}` : ""}`, { modal: true }, ...actions);
  const decision = choice === "Approve once" ? "accept"
    : choice === "Approve for session" ? "acceptForSession"
      : choice === "Cancel turn" ? "cancel"
        : available.has("decline") ? "decline" : "cancel";
  server.respond(id, { decision });
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await (await getServer()).start();
    output.appendLine(`Codex App Server ready; authentication mode: ${status.authMethod ?? "none"}; models: ${status.models.length}.`);
    setStatus(isChatGPTAuthentication(status.authMethod) ? "ready" : "auth-required");
  } catch (error) {
    output.appendLine(`[startup error] ${error instanceof Error ? error.message : "Unknown error."}`);
    setStatus("offline");
  }
}

function showDiagnostics(): void {
  output.show(true);
  output.appendLine("Diagnostics opened.");
}

function workspacePath(): string {
  const path = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!path) throw new Error("Open a workspace folder before submitting a routed task.");
  return path;
}

function sessionInput(task: string, metadata?: RoutingInput["metadata"]): RoutingSessionInput {
  return { routing: { task, metadata }, execution: { task } };
}

function formatRecommendation(recommendation: RoutingRecommendation, routingContext: string, executionContext: string): string {
  const origin = recommendation.source === "local-model" ? `experimental local classifier${recommendation.classifierModel ? ` (${recommendation.classifierModel})` : ""}` : "deterministic baseline";
  const fallback = [recommendation.providerFallback ? `Provider fallback: ${recommendation.providerFallback}.` : "", recommendation.catalogueFallback ? `Catalogue fallback: ${recommendation.catalogueFallback.reason}.` : ""].filter(Boolean).join(" ");
  const signals = recommendation.escalationSignals.length ? `\n\nSignals: ${recommendation.escalationSignals.join(" ")}` : "";
  return `**Codex Router recommendation** — ${recommendation.recommendedModel} / ${recommendation.recommendedEffort}\n\nStrength: ${recommendation.strength}; source: ${origin}; policy: ${recommendation.policyVersion}.\n\n${recommendation.reasons.map((reason) => `- ${reason}`).join("\n")}${signals}${fallback ? `\n\n${fallback}` : ""}\n\nRouting context: ${routingContext}.\n\nExecution context: ${executionContext}.\n\n`;
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
  statusItem.command = state === "running" ? "codexRouter.cancelActiveTurn" : "codexRouter.newRoutedTask";
  statusItem.tooltip = state === "running" ? "Cancel the active Codex Router turn" : "Codex Router — local routing with ChatGPT-authenticated Codex";
}

interface StreamSink {
  progress: (message: string) => void;
  text: (message: string) => void;
  activity?: (state: "awaiting-approval" | "starting" | "running", message: string) => void;
  onCancellationRequested?: (listener: () => void) => vscode.Disposable;
  chooseConfiguration?: (session: RoutingSessionController, recommendation: RoutingRecommendation, models: CodexModel[]) => Promise<AllocationSelection | undefined>;
  finish?: () => void;
  throughput?: (value: StreamThroughput) => void;
}

function notificationSink(): StreamSink {
  const uri = resultProvider.create();
  void vscode.workspace.openTextDocument(uri).then((document) => vscode.window.showTextDocument(document, { preview: true }));
  return {
    progress: (message) => output.appendLine(`[progress] ${message}`),
    text: (message) => resultProvider.append(uri, message)
  };
}

class RouterResultProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "codex-router-result";
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  create(): vscode.Uri {
    const uri = vscode.Uri.parse(`${RouterResultProvider.scheme}:Codex-Router-${randomUUID()}.md`);
    this.contents.set(uri.toString(), "# Codex Router result\n\n");
    return uri;
  }

  append(uri: vscode.Uri, value: string): void {
    this.contents.set(uri.toString(), `${this.contents.get(uri.toString()) ?? ""}${value}`);
    this.changed.fire(uri);
  }

  remove(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.contents.clear();
    this.changed.dispose();
  }
}

class RouterSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "codexRouter.sidebar";
  private view?: vscode.WebviewView;
  private pendingSelection?: { resolve: (selection: AllocationSelection | undefined) => void; session: RoutingSessionController; models: CodexModel[] };
  private inFlight = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = sidebarHtml(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => { void this.handleMessage(message); }, undefined, this.context.subscriptions);
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexRouter.routing.provider")) this.postRoutingProvider();
    }));
    view.onDidDispose(() => {
      this.pendingSelection?.resolve(undefined);
      this.pendingSelection = undefined;
      this.view = undefined;
    }, undefined, this.context.subscriptions);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isSidebarMessage(message)) return;
    if (message.type === "ready") {
      this.postRoutingProvider();
      return;
    }
    if (message.type === "cancel") {
      cancelActiveTurn();
      return;
    }
    if (message.type === "routing-provider") {
      try {
        await vscode.workspace.getConfiguration("codexRouter").update("routing.provider", message.provider, vscode.ConfigurationTarget.Global);
        this.postRoutingProvider();
      } catch (error) {
        this.post({ type: "error", message: error instanceof Error ? `Could not update the routing mode: ${error.message}` : "Could not update the routing mode." });
      }
      return;
    }
    if (message.type === "submit") {
      const task = message.task.trim();
      if (!task || this.inFlight) return;
      const active = vscode.window.activeTextEditor;
      const metadata = message.includeMetadata && active ? {
        languageId: active.document.languageId,
        relativeFileName: vscode.workspace.asRelativePath(active.document.uri),
        workspaceFolderCount: vscode.workspace.workspaceFolders?.length
      } : undefined;
      this.inFlight = true;
      this.post({ type: "started" });
      await routeAndRun(this.context, sessionInput(task, metadata), this.sink());
      return;
    }
    if (message.type === "selection" && this.pendingSelection) {
      const pending = this.pendingSelection;
      this.pendingSelection = undefined;
      try {
        const selection = message.useRecommendation
          ? pending.session.acceptRecommendation()
          : pending.session.override(message.model, message.effort, pending.models);
        pending.resolve(selection);
      } catch (error) {
        this.post({ type: "selection-invalid", message: error instanceof Error ? error.message : "Invalid model selection." });
        this.pendingSelection = pending;
      }
    }
  }

  private sink(): StreamSink {
    return {
      progress: (message) => this.post({ type: "progress", message }),
      text: (message) => this.post({ type: "output", message }),
      activity: (state, message) => this.post({ type: "activity", state, message }),
      throughput: (value) => this.post({ type: "throughput", value }),
      chooseConfiguration: (session, recommendation, models) => new Promise((resolve) => {
        this.pendingSelection = { resolve, session, models };
        this.post({
          type: "recommendation",
          recommendation: {
            model: recommendation.recommendedModel,
            effort: recommendation.recommendedEffort,
            strength: recommendation.strength,
            reasons: recommendation.reasons
          },
          models: models.filter((model) => !model.hidden).map((model) => ({
            model: model.model,
            displayName: model.displayName,
            efforts: model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort)
          }))
        });
      }),
      finish: () => {
        this.inFlight = false;
        this.post({ type: "finished" });
      }
    };
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private postRoutingProvider(): void {
    const provider = vscode.workspace.getConfiguration("codexRouter").get<RoutingProvider>("routing.provider", "deterministic");
    this.post({ type: "routing-provider", provider });
  }
}

function isSidebarMessage(value: unknown): value is { type: "ready" } | { type: "submit"; task: string; includeMetadata: boolean } | { type: "cancel" } | { type: "routing-provider"; provider: RoutingProvider } | { type: "selection"; useRecommendation: boolean; model: string; effort: string } {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type === "ready") return true;
  if (message.type === "cancel") return true;
  if (message.type === "routing-provider") return message.provider === "deterministic" || message.provider === "modeldeck-experimental";
  if (message.type === "submit") return typeof message.task === "string" && typeof message.includeMetadata === "boolean";
  return message.type === "selection" && typeof message.useRecommendation === "boolean" && typeof message.model === "string" && typeof message.effort === "string";
}

function sidebarHtml(webview: vscode.Webview): string {
  const nonce = randomUUID();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body{color:var(--vscode-foreground);font-family:var(--vscode-font-family);margin:0;padding:0 10px 12px}textarea,select,button{box-sizing:border-box;width:100%;font:inherit;margin-top:8px}textarea,select{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:6px}textarea{min-height:76px;resize:vertical}button{padding:7px;border:0;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}button:disabled{cursor:not-allowed;opacity:.55}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}label{display:block;margin-top:10px}.muted{color:var(--vscode-descriptionForeground);font-size:12px}.conversation{display:flex;flex-direction:column;gap:10px;margin:12px 0}.message{max-width:92%;padding:9px 10px;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:6px;font-size:12px;line-height:1.45}.message.user{align-self:flex-end;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}.message.assistant{align-self:flex-start;background:var(--vscode-editor-inactiveSelectionBackground)}.message.assistant[data-rate]::after{content:attr(data-rate);display:block;color:var(--vscode-descriptionForeground);font-size:11px;margin-top:6px}.card{border:1px solid var(--vscode-panel-border);padding:10px;margin-top:2px}.composer{border-top:1px solid var(--vscode-panel-border);padding-top:10px}.activity{align-items:center;background:var(--vscode-editor-inactiveSelectionBackground);display:flex;font-size:12px;gap:8px;margin:10px 0;padding:8px}.spinner{animation:spin .9s linear infinite;border:2px solid var(--vscode-descriptionForeground);border-right-color:transparent;border-radius:50%;height:12px;width:12px}@keyframes spin{to{transform:rotate(360deg)}}#recommendation,#cancel,#activity[hidden]{display:none}</style>
</head><body><h3>Codex Router</h3><p class="muted">A local conversation with your ChatGPT-authenticated Codex catalogue.</p><label for="provider">Routing mode</label><select id="provider"><option value="deterministic">Codex deterministic routing</option><option value="modeldeck-experimental">ModelDeck experimental classifier</option></select><p id="provider-note" class="muted">Codex executes every approved task. ModelDeck is a local, loopback-only adviser for the recommendation.</p><div id="activity" class="activity" role="status" aria-live="polite" hidden><span id="spinner" class="spinner" aria-hidden="true"></span><span id="activity-message"></span></div><main id="conversation" class="conversation" aria-live="polite"></main>
<section id="recommendation" class="card"><strong id="allocation"></strong><p id="reasons" class="muted"></p><button id="accept">Use recommendation</button><label for="model">Override model</label><select id="model"></select><label for="effort">Reasoning effort</label><select id="effort"></select><button id="override" class="secondary">Use override</button></section>
<section class="composer"><label for="task">Message</label><textarea id="task" placeholder="Describe the coding task"></textarea><label><input id="metadata" type="checkbox"> Include active-file metadata</label><p class="muted">Language and relative filename only — never source code.</p><button id="route">Send</button><button id="cancel" class="secondary">Cancel active turn</button></section>
<script nonce="${nonce}">const vscode=acquireVsCodeApi(),task=document.getElementById('task'),metadata=document.getElementById('metadata'),route=document.getElementById('route'),cancel=document.getElementById('cancel'),provider=document.getElementById('provider'),conversation=document.getElementById('conversation'),recommendation=document.getElementById('recommendation'),model=document.getElementById('model'),effort=document.getElementById('effort'),accept=document.getElementById('accept'),override=document.getElementById('override'),activity=document.getElementById('activity'),activityMessage=document.getElementById('activity-message'),spinner=document.getElementById('spinner');let models=[],assistantMessage,uiState='idle';function post(value){vscode.postMessage(value)}function addMessage(role,text){const message=document.createElement('div');message.className='message '+role;message.textContent=text;conversation.append(message);message.scrollIntoView({block:'end'});return message}function setUiState(state,message){uiState=state;const awaiting=state==='awaiting-approval',active=state==='starting'||state==='running',locked=state!=='idle';route.disabled=locked;task.disabled=locked;metadata.disabled=locked;provider.disabled=locked;accept.disabled=!awaiting;override.disabled=!awaiting;model.disabled=!awaiting;effort.disabled=!awaiting;cancel.style.display=active?'block':'none';recommendation.style.display=awaiting?'block':'none';activity.hidden=state==='idle';spinner.hidden=awaiting;if(message)activityMessage.textContent=message}function updateEfforts(){const selected=models.find(entry=>entry.model===model.value);effort.replaceChildren(...(selected?.efforts??[]).map(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;return option}))}route.addEventListener('click',()=>{const value=task.value.trim();if(!value)return;addMessage('user',value);assistantMessage=addMessage('assistant','Checking Codex…');task.value='';setUiState('analysing','Checking Codex and selecting a configuration…');post({type:'submit',task:value,includeMetadata:metadata.checked})});cancel.addEventListener('click',()=>post({type:'cancel'}));provider.addEventListener('change',()=>post({type:'routing-provider',provider:provider.value}));model.addEventListener('change',updateEfforts);accept.addEventListener('click',()=>{setUiState('starting','Starting Codex with the recommended configuration…');post({type:'selection',useRecommendation:true,model:'',effort:''})});override.addEventListener('click',()=>{setUiState('starting','Starting Codex with your override…');post({type:'selection',useRecommendation:false,model:model.value,effort:effort.value})});window.addEventListener('message',event=>{const message=event.data;if(message.type==='routing-provider'){provider.value=message.provider}if(message.type==='started'){setUiState('analysing','Checking Codex and selecting a configuration…')}if(message.type==='activity'){setUiState(message.state,message.message)}if(message.type==='progress'){if(assistantMessage)assistantMessage.textContent=message.message;if(uiState!=='awaiting-approval')activityMessage.textContent=message.message}if(message.type==='output'){if(assistantMessage)assistantMessage.textContent+=message.message}if(message.type==='throughput'&&assistantMessage&&message.value.tokensPerSecond){assistantMessage.dataset.rate='≈ '+message.value.tokensPerSecond.toFixed(1)+' tok/s'}if(message.type==='error'){if(assistantMessage)assistantMessage.textContent+=message.message}if(message.type==='recommendation'){models=message.models;document.getElementById('allocation').textContent=message.recommendation.model+' / '+message.recommendation.effort;document.getElementById('reasons').textContent=message.recommendation.reasons.join(' ');model.replaceChildren(...models.map(entry=>{const option=document.createElement('option');option.value=entry.model;option.textContent=entry.displayName+' ('+entry.model+')';return option}));model.value=message.recommendation.model;updateEfforts();effort.value=message.recommendation.effort;conversation.append(recommendation);setUiState('awaiting-approval','Choose a configuration to start Codex.');recommendation.scrollIntoView({block:'end'})}if(message.type==='finished'){setUiState('idle','');assistantMessage=undefined;task.focus()}});setUiState('idle','');post({type:'ready'});</script></body></html>`;
}
