import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { CodexAppServer, isChatGPTAuthentication } from "./appServer";
import { AllocationSelection, CodexModel, OUTCOME_SCHEMA_VERSION, ReasoningEffort, RoutingInput, RoutingProvider, RoutingRecommendation, RoutingSessionInput, TurnState } from "./contracts";
import { ModelDeckProvider, ProxyCandidateError, assertModelDeckModelId, classifierCatalogue, classifyModelDeckFailure } from "./modelDeck";
import { OutcomeStore, renderOutcomeMarkdown } from "./outcomes";
import { recommendWithProvider } from "./policy";
import { prepareSelectionProxyCandidate, renderProxyCandidateMarkdown } from "./proxy";
import { RoutingSessionController } from "./session";
import { StreamTokenEstimator, StreamThroughput } from "./streamMetrics";
import { RoutingDiagnostics, diagnosticIdentifier } from "./routingDiagnostics";
import { SidebarConversation } from "./conversation";
import { TurnActivity, TurnActivityTracker } from "./turnActivity";
import { activityScript } from "./activityUi";
import { markdownScript } from "./markdownUi";
import { TurnStopController } from "./turnStop";

let appServer: CodexAppServer | undefined;
let activeSession: RoutingSessionController | undefined;
let activeStopTurn: (() => void) | undefined;
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

async function routeAndRun(context: vscode.ExtensionContext, input: RoutingSessionInput, sink: StreamSink, conversation?: SidebarConversation): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    sink.text("Codex Router requires a trusted workspace before it can submit a coding task.");
    return;
  }

  let session: RoutingSessionController | undefined;
  let startedAt: number | undefined;
  let turnState: TurnState | undefined;
  let outcomeRecorded = false;
  let cancellationDisposable: vscode.Disposable | undefined;
  const diagnostics = new RoutingDiagnostics(vscode.workspace.getConfiguration("codexRouter").get<boolean>("diagnostics.developmentLogs", false), context.logUri.fsPath, (message) => output.appendLine(message));
  const originalSink = sink;
  sink = { ...originalSink, text: (message) => { diagnostics.delta(message); originalSink.text(message); } };
  try {
    diagnostics.sensitive("session.input", input);
    diagnostics.record("conversation.context", { continued: conversation?.hasContext ?? false });
    sink.progress("Checking ChatGPT-authenticated Codex and available models…");
    const server = await getServer();
    const status = await server.start();
    diagnostics.record("catalogue.received", { models: classifierCatalogue(status.models) });
    if (!isChatGPTAuthentication(status.authMethod)) {
      setStatus("auth-required");
      sink.text("Codex Router only submits through ChatGPT-authenticated Codex. Run `codex logout`, then `codex login`, and verify with `codex login status`.");
      return;
    }
    if (!status.models.length) throw new Error("Codex App Server reported no available models.");

    session = new RoutingSessionController(input, (routingInput, models) => route(routingInput, models, diagnostics), {
      execute: (prompt, selection, signal) => {
        diagnostics.sensitive("codex.prompt", prompt);
        return executeTurn(server, prompt, selection, signal, sink, conversation);
      }
    });
    const summaries = session.contextSummary();
    if (conversation?.hasContext) summaries.execution += "; previous turns in this conversation";
    sink.text(`**Context preview**\n\nRouting: ${summaries.routing}.\n\nCodex execution: ${summaries.execution}.\n\n`);
    const recommendation = await session.analyse(status.models);
    diagnostics.record("routing.recommended", { model: recommendation.recommendedModel, effort: recommendation.recommendedEffort, source: recommendation.source, providerFallback: recommendation.providerFallback, catalogueFallback: recommendation.catalogueFallback });
    session.awaitApproval();
    sink.activity?.("awaiting-approval", "Choose the recommended configuration or set an override to start Codex.");
    sink.text(formatRecommendation(recommendation, summaries.routing, summaries.execution));
    const choice = await (sink.chooseConfiguration ?? chooseConfiguration)(session, recommendation, status.models);
    if (!choice) {
      diagnostics.record("approval.dismissed", {});
      return;
    }
    diagnostics.record("approval.accepted", choice);

    sink.progress(`Starting Codex with ${choice.model} / ${choice.effort}…`);
    sink.activity?.("starting", `Starting Codex with ${choice.model} / ${choice.effort}…`);
    setStatus("running", choice.model, choice.effort);
    activeSession = session;
    cancellationDisposable = sink.onCancellationRequested?.(() => session?.cancel());
    startedAt = Date.now();
    turnState = await session.execute();
    diagnostics.record("turn.finished", { state: turnState, durationMs: Date.now() - startedAt });
    sink.text(turnState === "completed" ? "\n\nCodex turn completed.\n" : turnState === "cancelled" ? "\n\nCodex turn cancelled.\n" : "\n\nCodex turn failed.\n");
    setStatus("ready", choice.model, choice.effort);
    outcomeRecorded = true;
    await safeRecordOutcome(context, recommendation, choice, Date.now() - startedAt, turnState, input.execution.localProxyCandidate?.model);
  } catch (error) {
    const cancelled = session?.state === "cancelled";
    const message = error instanceof Error ? error.message : "Unexpected routing error.";
    diagnostics.record("session.error", { cancelled });
    diagnostics.sensitive("session.error.detail", message);
    output.appendLine(`[error] ${message}`);
    sink.text(cancelled ? "Codex Router cancelled the active turn." : `Codex Router could not complete the task: ${message}`);
    setStatus(cancelled ? "ready" : "error");
    if (!outcomeRecorded && session?.recommendation && session.selection && startedAt !== undefined) {
      turnState = cancelled ? "cancelled" : "failed";
      outcomeRecorded = true;
      await safeRecordOutcome(context, session.recommendation, session.selection, Date.now() - startedAt, turnState, input.execution.localProxyCandidate?.model);
    }
  } finally {
    diagnostics.finish(turnState ?? session?.state ?? "not-started");
    cancellationDisposable?.dispose();
    if (activeSession === session) activeSession = undefined;
    sink.finish?.();
  }
}

async function route(input: RoutingInput, models: CodexModel[], diagnostics: RoutingDiagnostics): Promise<RoutingRecommendation> {
  const configuration = vscode.workspace.getConfiguration("codexRouter");
  const provider = configuration.get<RoutingProvider>("routing.provider", "deterministic");
  const logRawClassifierResponses = configuration.get<boolean>("diagnostics.logRawClassifierResponses", false);
  diagnostics.record("routing.started", { provider });
  return recommendWithProvider(input, models, provider, () => new ModelDeckProvider({
      baseUrl: configuration.get<string>("modelDeck.baseUrl", "http://127.0.0.1:8600/v1"),
      routerModel: configuration.get<string>("modelDeck.routerModel", "") || undefined,
      timeoutMs: configuration.get<number>("requestTimeoutMs", 5_000),
      developmentDebug: configuration.get<boolean>("diagnostics.developmentLogs", false) ? (event, detail) => diagnostics.sensitive(`classifier.${event}`, detail) : undefined
    }), (fallback, diagnostic, rawResponse) => {
      diagnostics.record("routing.fallback", { fallback, diagnostic });
      output.appendLine(`[router fallback] ${fallback}${diagnostic ? ` (${diagnostic})` : ""}`);
      if (logRawClassifierResponses && rawResponse !== undefined) {
        output.appendLine("[router classifier raw response — sensitive diagnostic output]");
        output.appendLine(rawResponse);
        output.appendLine("[end router classifier raw response]");
      }
    }, (rejection) => diagnostics.record("routing.allocation-rejected", { ...rejection, requestedModel: diagnosticIdentifier(rejection.requestedModel), requestedEffort: diagnosticIdentifier(rejection.requestedEffort) }));
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

async function executeTurn(server: CodexAppServer, prompt: string, selection: AllocationSelection, signal: AbortSignal, sink: StreamSink, conversation?: SidebarConversation): Promise<TurnState> {
  const earlyEvents: Array<{ method: string; params: unknown }> = [];
  const bufferEarlyEvent = (method: string, params: unknown) => earlyEvents.push({ method, params });
  const bufferEarlyRequest = (requestId: number | string, method: string, params: unknown) => {
    if (params && typeof params === "object") bufferEarlyEvent(method, { ...params, requestId });
  };
  server.on("notification", bufferEarlyEvent);
  server.on("request", bufferEarlyRequest);
  let started: { threadId: string; turnId: string };
  try {
    started = conversation ? await conversation.startTurn(server, prompt, workspacePath(), selection) : await server.startTurn(prompt, workspacePath(), selection.model, selection.effort);
  } finally {
    server.off("notification", bufferEarlyEvent);
    server.off("request", bufferEarlyRequest);
  }
  const { threadId, turnId } = started;
  sink.activity?.("running", `Codex is working with ${selection.model} / ${selection.effort}.`);

  const stop = new TurnStopController(() => server.interruptTurn(threadId, turnId), (stopping) => {
    const message = stopping ? "Stopping the model… Waiting for Codex to confirm." : "Stop request failed. The turn may still be running; select Stop model to retry.";
    sink.activity?.(stopping ? "stopping" : "running", message);
    if (!sink.activity) sink.progress(message);
  });
  const interrupt = (): void => stop.request();
  const requestStop = (): void => {
    if (!signal.aborted) activeSession?.cancel();
    interrupt();
  };
  activeStopTurn = requestStop;
  signal.addEventListener("abort", interrupt, { once: true });
  if (signal.aborted) interrupt();
  try {
    return await streamTurn(server, threadId, turnId, sink, earlyEvents);
  } finally {
    stop.dispose();
    if (activeStopTurn === requestStop) activeStopTurn = undefined;
    signal.removeEventListener("abort", interrupt);
  }
}

async function streamTurn(server: CodexAppServer, threadId: string, turnId: string, sink: StreamSink, earlyEvents: Array<{ method: string; params: unknown }>): Promise<TurnState> {
  return new Promise<TurnState>((resolve, reject) => {
    let done = false;
    const activity = new TurnActivityTracker(threadId, turnId, (value) => sink.turnActivity?.(value));
    const tokenEstimator = new StreamTokenEstimator();
    const timer = setTimeout(() => {
      void server.interruptTurn(threadId, turnId).catch(() => undefined);
      finish(undefined, new Error("Timed out waiting for Codex to finish the turn."));
    }, 20 * 60_000);
    const listener = (method: string, params: unknown): void => {
      if (done || !params || typeof params !== "object") return;
      activity.observe(method, params);
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
    const request = (requestId: number | string, method: string, params: unknown): void => {
      if (params && typeof params === "object") listener(method, { ...params, requestId });
    };
    const finish = (state?: TurnState, error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      activity.finish(state ?? "failed");
      server.off("notification", listener);
      server.off("request", request);
      server.off("stopped", stopped);
      error ? reject(error) : resolve(state ?? "failed");
    };
    server.on("notification", listener);
    server.on("request", request);
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
  if (activeStopTurn) { activeStopTurn(); return; }
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
  activity?: (state: "awaiting-approval" | "starting" | "running" | "stopping", message: string) => void;
  onCancellationRequested?: (listener: () => void) => vscode.Disposable;
  chooseConfiguration?: (session: RoutingSessionController, recommendation: RoutingRecommendation, models: CodexModel[]) => Promise<AllocationSelection | undefined>;
  finish?: () => void;
  throughput?: (value: StreamThroughput) => void;
  turnActivity?: (value: TurnActivity) => void;
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
  private readonly conversation = new SidebarConversation();

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
      this.conversation.reset();
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
    if (message.type === "new-conversation") {
      if (this.inFlight) return;
      this.conversation.reset();
      this.post({ type: "conversation-reset" });
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
      try {
        await routeAndRun(this.context, sessionInput(task, metadata), this.sink(), this.conversation);
      } finally {
        this.inFlight = false;
      }
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
        this.post({ type: "error", message: error instanceof Error ? error.message : "Invalid model selection." });
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
      turnActivity: (value) => this.post({ type: "turn-activity", value }),
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

function isSidebarMessage(value: unknown): value is { type: "ready" } | { type: "new-conversation" } | { type: "submit"; task: string; includeMetadata: boolean } | { type: "cancel" } | { type: "routing-provider"; provider: RoutingProvider } | { type: "selection"; useRecommendation: boolean; model: string; effort: string } {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type === "ready") return true;
  if (message.type === "new-conversation") return true;
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
<style>
:root{color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
*{box-sizing:border-box}body{margin:0;padding:8px}button,select,textarea{font:inherit}button,select,textarea,input{outline-offset:2px}button:focus-visible,select:focus-visible,textarea:focus-visible,input:focus-visible,summary:focus-visible{outline:1px solid var(--vscode-focusBorder)}
.field{display:block;font-size:12px;margin:10px 0 4px}.field-inline{align-items:center;display:flex;font-size:12px;gap:6px;margin:0}.field-inline input{margin:0}.hint{color:var(--vscode-descriptionForeground);font-size:11px;line-height:1.4;margin:4px 0 0}
html,body{height:100%;overflow:hidden}body{display:flex;flex-direction:column;gap:8px;padding:8px 12px}.panel-header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0}.panel-title{font-size:12px;color:var(--vscode-descriptionForeground)}.panel-header .button{background:transparent;color:var(--vscode-foreground)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}.composer-dock{flex-shrink:0;max-height:55vh;overflow:auto;padding:2px}.composer{border:1px solid var(--vscode-input-border,var(--vscode-widget-border,var(--vscode-panel-border)));border-radius:16px;padding:8px;background:var(--vscode-input-background)}.composer:focus-within{border-color:var(--vscode-focusBorder)}.composer textarea:focus-visible{outline:none}.composer textarea{background:transparent;border:0;border-radius:8px;resize:none;min-height:56px;max-height:25vh;overflow:auto}.composer-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px}.source-picker{flex:1 1 130px;min-width:0}.source-picker select{background:transparent;border:0;font-size:12px;color:var(--vscode-descriptionForeground)}.composer-options{font-size:12px;position:relative}.composer-options summary{list-style:none;border-radius:4px;padding:5px 7px;color:var(--vscode-descriptionForeground)}.composer-options summary::-webkit-details-marker{display:none}.composer-options[open]{flex-basis:100%}.composer-options[open] summary{padding-left:0}.options-content{padding:4px 2px 8px}.options-content .hint{max-width:65ch}.composer-toolbar .send{border-radius:50%;width:30px;height:30px;min-height:30px;padding:0;font-size:20px;flex-shrink:0}.composer-toolbar #cancel{border-radius:14px;flex-shrink:0}.composer-hint{font-size:11px;color:var(--vscode-descriptionForeground);margin:5px 8px 0}summary{cursor:pointer}

textarea,select{background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-widget-border,transparent));border-radius:3px;color:var(--vscode-input-foreground);padding:6px;width:100%}textarea{display:block;line-height:1.4;min-height:60px;resize:vertical}textarea::placeholder{color:var(--vscode-input-placeholderForeground)}select{height:28px}
.actions{display:flex;gap:6px;margin-top:10px}.actions button{flex:1}.button{border:0;border-radius:2px;cursor:pointer;min-height:28px;padding:4px 8px}.button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.button.primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}.button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.button.secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}.button:disabled{cursor:default;opacity:.55}
.run-controls{display:flex;align-items:center;gap:8px}.run-controls:has(#activity:not([hidden])){padding:8px 0}.run-controls .button{flex-shrink:0}.activity{align-items:center;color:var(--vscode-descriptionForeground);display:flex;font-size:12px;gap:7px;min-width:0;overflow-wrap:anywhere}.spinner{flex-shrink:0;animation:spin .9s linear infinite;border:2px solid var(--vscode-descriptionForeground);border-right-color:transparent;border-radius:50%;height:11px;width:11px}@keyframes spin{to{transform:rotate(360deg)}}
.conversation{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;margin:0;scrollbar-gutter:stable;padding:8px 2px}.message{flex-shrink:0;font-size:var(--vscode-font-size);line-height:1.6;overflow-wrap:anywhere;padding:7px 8px}.message.user{border-radius:16px;padding:10px 14px;align-self:flex-end;background:var(--vscode-editor-inactiveSelectionBackground);max-width:92%;white-space:pre-wrap}.message.assistant{padding:4px 2px}.message.assistant[data-rate]::after{color:var(--vscode-descriptionForeground);content:attr(data-rate);display:block;font-size:11px;margin-top:4px}.message.assistant>:first-child{margin-top:0}.message.assistant>:last-child{margin-bottom:0}.message.assistant p,.message.assistant ul,.message.assistant ol,.message.assistant blockquote,.message.assistant pre{margin:0 0 10px}.message.assistant ul,.message.assistant ol{padding-left:22px}.message.assistant blockquote{border-left:2px solid var(--vscode-textBlockQuote-border);color:var(--vscode-descriptionForeground);padding-left:10px}.message.assistant pre{background:var(--vscode-textCodeBlock-background);overflow:auto;padding:8px;white-space:pre}.message.assistant code{font-family:var(--vscode-editor-font-family);font-size:.95em}.message.assistant :not(pre)>code{background:var(--vscode-textCodeBlock-background);border-radius:3px;padding:1px 3px}.message.assistant a{color:var(--vscode-textLink-foreground)}.message.assistant h1,.message.assistant h2,.message.assistant h3,.message.assistant h4,.message.assistant h5,.message.assistant h6{line-height:1.3;margin:14px 0 8px}.message.assistant h1{font-size:1.45em}.message.assistant h2{font-size:1.3em}.message.assistant h3{font-size:1.15em}
.conversation:empty::before{content:"What would you like to work on?";margin:auto;text-align:center;color:var(--vscode-descriptionForeground);font-size:16px}.conversation>.recommendation,.conversation>.live-feed{flex-shrink:0}.recommendation{border-left:2px solid var(--vscode-button-background);font-size:12px;margin-top:2px;padding:8px;overflow-wrap:anywhere}.allocation{font-family:var(--vscode-editor-font-family);font-weight:600;margin:0}.recommendation .hint{margin-bottom:8px}.override-fields{margin-top:8px}.override-fields .field{margin-top:8px}
.live-feed{border:1px solid var(--vscode-widget-border);padding:8px;font-size:12px}.live-feed details{margin-top:8px}.live-feed summary{cursor:pointer;overflow-wrap:anywhere}.live-feed summary:focus-visible{outline:1px solid var(--vscode-focusBorder)}.live-feed pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font-family:var(--vscode-editor-font-family)}
@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
#recommendation,#cancel,#activity[hidden]{display:none}
</style>
</head><body>
<header class="panel-header"><span class="panel-title">Conversation</span><button id="newConversation" class="button secondary" type="button" title="Clear this conversation and start without previous turns">+ New conversation</button></header>
<main id="conversation" class="conversation" aria-live="polite" aria-label="Codex Router conversation"></main>
<footer class="composer-dock">
<div class="run-controls"><div id="activity" class="activity" role="status" aria-live="polite" hidden><span id="spinner" class="spinner" aria-hidden="true"></span><span id="activity-message"></span></div></div>
<section class="composer" aria-label="New routed task">
<label class="sr-only" for="task">Task</label><textarea id="task" rows="2" placeholder="Ask for changes or a follow-up…" aria-describedby="task-hint"></textarea>
<div class="composer-toolbar"><details class="composer-options"><summary title="Task context and conversation help">Context</summary><div class="options-content"><label class="field-inline"><input id="metadata" type="checkbox"> Include active-file metadata</label><p class="hint">Shares the language and relative filename, but no source code.</p><p class="hint">Follow-ups retain previous Codex turns until you start a new conversation or close this view.</p></div></details><div class="source-picker"><label class="sr-only" for="provider">Recommendation source</label><select id="provider" title="Recommendation source"><option value="deterministic">Deterministic</option><option value="modeldeck-experimental">Local SLM (experimental)</option></select></div><button id="submit" class="button primary send" type="button" aria-label="Recommend a model for this task" title="Recommend a model (Enter)">↑</button><button id="cancel" class="button secondary" type="button" aria-label="Stop the active Codex turn">Stop model</button></div>
</section><p id="task-hint" class="composer-hint">Enter to recommend · Shift+Enter for a new line</p></footer>
<section id="recommendation" class="recommendation" aria-label="Recommended Codex configuration"><p id="allocation" class="allocation"></p><p id="reasons" class="hint"></p><div class="actions"><button id="accept" class="button primary">Start Codex</button></div><details class="override-fields"><summary>Override model or effort</summary><label class="field" for="model">Override model</label><select id="model"></select><label class="field" for="effort">Effort</label><select id="effort"></select><div class="actions"><button id="override" class="button secondary">Start override</button></div></details></section>
<script nonce="${nonce}">${markdownScript}const vscode=acquireVsCodeApi(),task=document.getElementById('task'),metadata=document.getElementById('metadata'),cancel=document.getElementById('cancel'),provider=document.getElementById('provider'),conversation=document.getElementById('conversation'),recommendation=document.getElementById('recommendation'),model=document.getElementById('model'),effort=document.getElementById('effort'),accept=document.getElementById('accept'),override=document.getElementById('override'),activity=document.getElementById('activity'),activityMessage=document.getElementById('activity-message'),spinner=document.getElementById('spinner');let models=[],assistantMessage,assistantText='',uiState='idle';function post(value){vscode.postMessage(value)}function addMessage(role,text){const message=document.createElement('div');message.className='message '+role;if(role==='assistant'){assistantText=text;renderMarkdown(message,text)}else message.textContent=text;conversation.append(message);message.scrollIntoView({block:'end'});return message}function setUiState(state,message){uiState=state;const awaiting=state==='awaiting-approval',active=state==='starting'||state==='running'||state==='stopping',locked=state!=='idle';task.disabled=locked;document.getElementById('submit').disabled=locked||!task.value.trim();document.getElementById('submit').hidden=active;document.getElementById('newConversation').disabled=locked;metadata.disabled=locked;provider.disabled=locked;accept.disabled=!awaiting;override.disabled=!awaiting;model.disabled=!awaiting;effort.disabled=!awaiting;cancel.style.display=active?'block':'none';cancel.disabled=state==='stopping';cancel.textContent=state==='stopping'?'Stopping…':'Stop model';recommendation.style.display=awaiting?'block':'none';if(!awaiting)recommendation.querySelector('details').open=false;activity.hidden=state==='idle';spinner.hidden=awaiting;if(message)activityMessage.textContent=message}function updateAssistant(text,append){if(!assistantMessage)return;const follow=conversation.scrollHeight-conversation.scrollTop-conversation.clientHeight<48;assistantText=append?assistantText+text:text;renderMarkdown(assistantMessage,assistantText);if(follow)conversation.scrollTop=conversation.scrollHeight}function updateEfforts(){const selected=models.find(entry=>entry.model===model.value);effort.replaceChildren(...(selected?.efforts??[]).map(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;return option}))}function resizeTask(){task.style.height='auto';task.style.height=Math.min(task.scrollHeight,window.innerHeight*.25)+'px'}function submit(){const value=task.value.trim();if(!value||uiState!=='idle')return;addMessage('user',value);assistantMessage=addMessage('assistant','Checking Codex…');task.value='';resizeTask();setUiState('analysing','Checking Codex and selecting a configuration…');post({type:'submit',task:value,includeMetadata:metadata.checked})}document.getElementById('submit').addEventListener('click',submit);task.addEventListener('input',()=>{resizeTask();document.getElementById('submit').disabled=uiState!=='idle'||!task.value.trim()});window.addEventListener('resize',resizeTask);task.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!task.disabled){event.preventDefault();submit()}});document.getElementById('newConversation').addEventListener('click',()=>post({type:'new-conversation'}));cancel.addEventListener('click',()=>{if(cancel.disabled)return;setUiState('stopping','Stopping the model… Waiting for Codex to confirm.');post({type:'cancel'})});provider.addEventListener('change',()=>post({type:'routing-provider',provider:provider.value}));model.addEventListener('change',updateEfforts);accept.addEventListener('click',()=>{setUiState('starting','Starting Codex with the recommended configuration…');post({type:'selection',useRecommendation:true,model:'',effort:''})});override.addEventListener('click',()=>{setUiState('starting','Starting Codex with your override…');post({type:'selection',useRecommendation:false,model:model.value,effort:effort.value})});window.addEventListener('message',event=>{const message=event.data;if(message.type==='conversation-reset'){document.body.append(recommendation);recommendation.style.display='none';conversation.replaceChildren();assistantMessage=undefined;assistantText='';task.focus()}if(message.type==='routing-provider'){provider.value=message.provider}if(message.type==='started'){setUiState('analysing','Checking Codex and selecting a configuration…')}if(message.type==='activity'){setUiState(message.state,message.message)}if(message.type==='progress'){updateAssistant(message.message,false);if(uiState!=='awaiting-approval')activityMessage.textContent=message.message}if(message.type==='output'){updateAssistant(message.message,true)}if(message.type==='throughput'&&assistantMessage&&message.value.tokensPerSecond){assistantMessage.dataset.rate='≈ '+message.value.tokensPerSecond.toFixed(1)+' tok/s'}if(message.type==='error'){updateAssistant(message.message,true)}if(message.type==='recommendation'){models=message.models;document.getElementById('allocation').textContent=message.recommendation.model+' / '+message.recommendation.effort;document.getElementById('reasons').textContent=message.recommendation.reasons.join(' ');model.replaceChildren(...models.map(entry=>{const option=document.createElement('option');option.value=entry.model;option.textContent=entry.displayName+' ('+entry.model+')';return option}));model.value=message.recommendation.model;updateEfforts();effort.value=message.recommendation.effort;conversation.append(recommendation);setUiState('awaiting-approval','Review the recommendation before starting Codex.');recommendation.scrollIntoView({block:'end'});accept.focus()}if(message.type==='finished'){setUiState('idle','');assistantMessage=undefined;assistantText='';task.focus()}});setUiState('idle','');post({type:'ready'});${activityScript}</script></body></html>`;
}
