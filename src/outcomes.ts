import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { OutcomeRecord } from "./contracts";

export interface OutcomeGroupSummary {
  policyVersion: string;
  routingSource: OutcomeRecord["routingSource"];
  model: string;
  effort: string;
  sampleSize: number;
  outcomeObserved: number;
  missingOutcomeRate: number;
  overrides: number;
  completed: number;
  incomplete: number;
  failed: number;
  validationPassed: number;
  validationFailed: number;
  validationNotRun: number;
  validationNotObserved: number;
  validationUnreported: number;
  verified: number;
  underPowered: number;
  overPowered: number;
  repairTurns: number;
  totalDurationMs: number;
  elapsedMsPerVerifiedCompletion: number | null;
  smallSample: boolean;
}

export class OutcomeStore {
  private readonly path: string;

  public constructor(private readonly directory: string) {
    this.path = join(directory, "outcomes.ndjson");
  }

  async append(record: OutcomeRecord): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await fs.appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async readAll(): Promise<OutcomeRecord[]> {
    let content: string;
    try { content = await fs.readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: OutcomeRecord[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (isOutcomeRecord(value)) records.push(value);
    }
    return records;
  }

  async clear(): Promise<void> {
    try { await fs.unlink(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  static workspaceId(paths: readonly string[]): string {
    return createHash("sha256").update([...paths].sort().join("\u0000")).digest("hex").slice(0, 20);
  }
}

export function summariseOutcomes(records: readonly OutcomeRecord[]): OutcomeGroupSummary[] {
  const groups = new Map<string, OutcomeGroupSummary>();
  for (const record of records) {
    const key = [record.policyVersion, record.routingSource, record.selected.model, record.selected.effort].join("\u0000");
    const group = groups.get(key) ?? {
      policyVersion: record.policyVersion,
      routingSource: record.routingSource,
      model: record.selected.model,
      effort: record.selected.effort,
      sampleSize: 0,
      outcomeObserved: 0,
      missingOutcomeRate: 0,
      overrides: 0,
      completed: 0,
      incomplete: 0,
      failed: 0,
      validationPassed: 0,
      validationFailed: 0,
      validationNotRun: 0,
      validationNotObserved: 0,
      validationUnreported: 0,
      verified: 0,
      underPowered: 0,
      overPowered: 0,
      repairTurns: 0,
      totalDurationMs: 0,
      elapsedMsPerVerifiedCompletion: null,
      smallSample: true
    };
    group.sampleSize++;
    if (record.taskOutcome !== "unreported") group.outcomeObserved++;
    if (record.selected.overridden) group.overrides++;
    if (record.taskOutcome === "completed") group.completed++;
    if (record.taskOutcome === "incomplete") group.incomplete++;
    if (record.taskOutcome === "failed") group.failed++;
    if (record.validationStatus === "passed") group.validationPassed++;
    if (record.validationStatus === "failed") group.validationFailed++;
    if (record.validationStatus === "not-run") group.validationNotRun++;
    if (record.validationStatus === "not-observed") group.validationNotObserved++;
    if (record.validationStatus === "unreported") group.validationUnreported++;
    if (record.taskOutcome === "completed" && record.validationStatus === "passed") group.verified++;
    if (record.allocationJudgement === "under-powered") group.underPowered++;
    if (record.allocationJudgement === "over-powered") group.overPowered++;
    group.repairTurns += record.repairTurns ?? 0;
    group.totalDurationMs += record.durationMs;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    missingOutcomeRate: group.sampleSize === 0 ? 0 : (group.sampleSize - group.outcomeObserved) / group.sampleSize,
    elapsedMsPerVerifiedCompletion: group.verified === 0 ? null : Math.round(group.totalDurationMs / group.verified),
    smallSample: group.outcomeObserved < 20 || group.verified < 5
  }));
}

export function renderOutcomeMarkdown(records: readonly OutcomeRecord[]): string {
  const groups = summariseOutcomes(records);
  const lines = [
    "# Codex Router outcome report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "This report is descriptive local evidence, not a causal comparison. User ratings, deterministic simulation, classifier calibration, and live Codex evidence must be interpreted separately.",
    "",
    `Total records: ${records.length}`,
    "",
    "| Policy | Source | Selected allocation | Sample | Missing outcome | Override rate | Task outcomes | Build/test results | Verified | Repairs | Under-powered | Over-powered | Elapsed per verified completion | Evidence |",
    "| --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |"
  ];
  for (const group of groups) {
    const taskOutcomes = `completed ${group.completed}; incomplete ${group.incomplete}; failed ${group.failed}; unreported ${group.sampleSize - group.outcomeObserved}`;
    const validation = `passed ${group.validationPassed}; failed ${group.validationFailed}; not run ${group.validationNotRun}; not observed ${group.validationNotObserved}; unreported ${group.validationUnreported}`;
    lines.push(`| ${escapeCell(group.policyVersion)} | ${group.routingSource} | ${escapeCell(group.model)} / ${escapeCell(group.effort)} | ${group.sampleSize} | ${percent(group.missingOutcomeRate)} | ${percent(group.overrides / group.sampleSize)} | ${taskOutcomes} | ${validation} | ${group.verified} | ${group.repairTurns} | ${group.underPowered} | ${group.overPowered} | ${group.elapsedMsPerVerifiedCompletion === null ? "n/a" : formatDuration(group.elapsedMsPerVerifiedCompletion)} | ${group.smallSample ? "Small or incomplete sample; do not change policy" : "Descriptive evidence only"} |`);
  }
  if (groups.length === 0) lines.push("| — | — | — | 0 | — | — | — | — | — | — | — | — | — | No outcome records | ");
  lines.push("", "Verified completion requires a user-reported completed task and a passed build/test result. Not run, not observed, and unreported validation do not count as verified.", "");
  return lines.join("\n");
}

function isOutcomeRecord(value: unknown): value is OutcomeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<OutcomeRecord>;
  return record.schemaVersion === 2
    && typeof record.recordId === "string"
    && typeof record.timestamp === "string"
    && typeof record.workspaceId === "string"
    && typeof record.policyVersion === "string"
    && typeof record.routingSource === "string"
    && typeof record.recommendationStrength === "string"
    && typeof record.durationMs === "number"
    && typeof record.turnState === "string"
    && typeof record.taskOutcome === "string"
    && typeof record.validationStatus === "string"
    && typeof record.allocationJudgement === "string"
    && Boolean(record.recommendation)
    && Boolean(record.selected);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
