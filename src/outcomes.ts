import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { OutcomeRecord } from "./contracts";

export class OutcomeStore {
  public constructor(private readonly directory: string) {}

  async append(record: OutcomeRecord): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await fs.appendFile(join(this.directory, "outcomes.ndjson"), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  static workspaceId(paths: readonly string[]): string {
    return createHash("sha256").update([...paths].sort().join("\u0000")).digest("hex").slice(0, 20);
  }
}
