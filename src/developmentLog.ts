import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Best-effort filtering; development logs still contain sensitive task and source content. */
export function redactDebugText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[REDACTED TOKEN]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [REDACTED]")
    .replace(/((?:["']?)(?:[\w-]*(?:token|secret|password|api[_-]?key)|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, "$1[REDACTED]");
}

export class DevelopmentLog {
  public readonly path: string;

  public constructor(resultsDirectory: string) {
    const root = join(resultsDirectory, "debug");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(root, "run-"));
    this.path = join(directory, "events.jsonl");
    writeFileSync(this.path, "", { mode: 0o600, flag: "wx" });
    this.write("debug.enabled", "Sensitive local development log. Review before sharing; redaction is best effort.");
  }

  public write(event: string, detail: unknown): void {
    const sanitise = (value: unknown): unknown => {
      if (typeof value === "string") {
        if (/^\s*[\[{]/.test(value)) {
          try { return JSON.stringify(sanitise(JSON.parse(value))); } catch { /* Plain or malformed model output is filtered as text. */ }
        }
        return redactDebugText(value);
      }
      if (Array.isArray(value)) return value.map(sanitise);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|api.?key|authorization|cookie/i.test(key) && typeof item === "string" ? "[REDACTED]" : sanitise(item)]));
      return value;
    };
    appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), event, detail: sanitise(detail) })}\n`, "utf8");
  }
}

/** Collect complete lines before redaction so split stream chunks cannot split a token. */
export function debugLineSink(write: (line: string) => void): { push(chunk: string): void; finish(): void } {
  let pending = "";
  let oversized = false;
  let privateKey = false;
  const emit = () => {
    if (pending.includes("-----BEGIN") && pending.includes("PRIVATE KEY-----")) privateKey = true;
    if (privateKey) {
      write("[REDACTED PRIVATE KEY LINE]");
      if (pending.includes("-----END") && pending.includes("PRIVATE KEY-----")) privateKey = false;
    } else write(oversized ? "[Oversized debug line withheld]" : pending);
    pending = "";
    oversized = false;
  };
  return {
    push(chunk) {
      for (const part of chunk.split(/(?<=\n)/)) {
        if (!oversized) {
          pending += part;
          if (pending.length > 65_536) { pending = ""; oversized = true; }
        }
        if (part.endsWith("\n")) emit();
      }
    },
    finish() { if (pending || oversized) emit(); }
  };
}

