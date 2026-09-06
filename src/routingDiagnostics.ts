import { randomUUID } from "node:crypto";
import { DevelopmentLog, debugLineSink, redactDebugText } from "./developmentLog";

/** One diagnostic session for either the sidebar or a command-palette task. */
export class RoutingDiagnostics {
  private readonly id = randomUUID();
  private log?: DevelopmentLog;
  private readonly lines = debugLineSink((line) => this.sensitive("codex.output", line));

  public constructor(enabled: boolean, directory: string, private readonly output: (message: string) => void) {
    if (enabled) {
      try {
        this.log = new DevelopmentLog(directory);
        output(`[development logs] Sensitive local log: ${this.log.path}`);
      } catch {
        output("[development logs] Unable to create the log; detailed capture is disabled.");
      }
    }
    this.record("session.started", {});
  }

  public record(event: string, metadata: unknown): void {
    this.output(`[${new Date().toISOString()}] [${this.id}] ${event} ${redactDebugText(JSON.stringify(metadata))}`);
    this.sensitive(event, metadata);
  }

  public sensitive(event: string, detail: unknown): void {
    if (!this.log) return;
    try { this.log.write(event, detail); } catch {
      this.log = undefined;
      this.output("[development logs] Unable to write the log; detailed capture has stopped.");
    }
  }

  public delta(text: string): void {
    if (this.log) this.lines.push(text);
  }

  public finish(state: string): void {
    this.lines.finish();
    this.record("session.finished", { state });
  }
}

/** Rejected model output is untrusted, even when it occupies an identifier field. */
export function diagnosticIdentifier(value: string): string {
  return /^[A-Za-z0-9._:/-]{1,128}$/.test(value) ? redactDebugText(value) : "[invalid identifier withheld]";
}
