import { debugLineSink, redactDebugText } from "./developmentLog";

export interface TurnActivity {
  id: string;
  label: string;
  status: string;
  detail: string;
  startedAt: number;
  finishedAt?: number;
}

const labels: Record<string, string> = {
  commandExecution: "Command", fileChange: "File changes", reasoning: "Reasoning summary",
  mcpToolCall: "Tool call", dynamicToolCall: "Tool call", webSearch: "Web search",
  contextCompaction: "Compacting conversation", plan: "Plan", imageView: "Viewing image"
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Only allowlisted presentation fields leave the host; no raw protocol or tool arguments. */
export class TurnActivityTracker {
  private readonly entries = new Map<string, { value: TurnActivity; lines: ReturnType<typeof debugLineSink> }>();
  private readonly approvals = new Map<string | number, string>();

  constructor(private readonly threadId: string, private readonly turnId: string, private readonly emit: (activity: TurnActivity) => void) {}

  observe(method: string, params: unknown): void {
    const event = record(params);
    if (method === "serverRequest/resolved" && event.threadId === this.threadId) {
      const requestId = event.requestId;
      if (typeof requestId !== "string" && typeof requestId !== "number") return;
      const id = this.approvals.get(requestId);
      this.approvals.delete(requestId);
      const entry = id ? this.entries.get(id) : undefined;
      if (entry && !entry.value.finishedAt) {
        entry.value.status = "Approval resolved; waiting for activity";
        this.emit({ ...entry.value });
      }
      return;
    }
    if (event.threadId !== this.threadId || event.turnId !== this.turnId) return;
    const item = record(event.item);
    const id = typeof item.id === "string" ? item.id : event.itemId;
    if (typeof id !== "string" || id.length > 256) return;
    const type = typeof item.type === "string" ? item.type : method === "item/commandExecution/outputDelta" ? "commandExecution"
      : method === "item/reasoning/summaryTextDelta" ? "reasoning" : undefined;
    const approval = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
    const lifecycle = method === "item/started" || method === "item/completed";
    const delta = method === "item/commandExecution/outputDelta" || method === "item/reasoning/summaryTextDelta";
    if (!approval && !lifecycle && !delta) return;
    let entry = this.entries.get(id);
    if (!entry) {
      const label = approval ? "Approval" : type && labels[type];
      if (!label || this.entries.size >= 100) return;
      const value: TurnActivity = { id, label, status: "Running", detail: "", startedAt: Date.now() };
      entry = { value, lines: debugLineSink((line) => {
        if (value.detail.length < 16_384) value.detail += redactDebugText(line).slice(0, 16_384 - value.detail.length);
      }) };
      this.entries.set(id, entry);
    }
    const value = entry.value;
    if (value.finishedAt) return;
    if (type && labels[type]) value.label = labels[type];
    if (approval) {
      value.status = "Awaiting approval";
      if (this.approvals.size < 100 && (typeof event.requestId === "string" || typeof event.requestId === "number")) this.approvals.set(event.requestId, id);
    }
    if (lifecycle) {
      const heading = [item.command, item.tool, item.query, item.path, item.type === "plan" ? item.text : undefined].filter((part): part is string => typeof part === "string").join("\n");
      if (heading && !value.detail) value.detail = (redactDebugText(heading.slice(0, 16_384)) + "\n").slice(0, 16_384);
      if (item.type === "fileChange" && Array.isArray(item.changes)) {
        value.detail = redactDebugText(item.changes.slice(0, 100).map((change) => record(change).path).filter((path): path is string => typeof path === "string").join("\n").slice(0, 16_384));
      }
    }
    if (delta && typeof event.delta === "string") {
      value.status = "Running";
      entry.lines.push(event.delta);
    }
    if (method === "item/completed") {
      entry.lines.finish();
      if (typeof item.aggregatedOutput === "string") value.detail = redactDebugText([item.command, item.aggregatedOutput].filter((part) => typeof part === "string").join("\n").slice(0, 16_384));
      if (item.type === "reasoning" && Array.isArray(item.summary)) value.detail = redactDebugText(item.summary.filter((part): part is string => typeof part === "string").join("\n\n").slice(0, 16_384));
      value.status = item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0) ? "Failed" : item.status === "declined" ? "Declined" : "Completed";
      if (typeof item.exitCode === "number") value.status += ` (exit ${item.exitCode})`;
      value.finishedAt = Date.now();
    }
    this.emit({ ...value });
  }

  finish(state: string): void {
    for (const { value, lines } of this.entries.values()) {
      if (value.finishedAt) continue;
      lines.finish();
      value.status = `Turn ${state}; no completion event`;
      value.finishedAt = Date.now();
      this.emit({ ...value });
    }
    this.entries.clear();
    this.approvals.clear();
  }
}
