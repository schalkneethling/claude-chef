import type { ChefStationBackfill, ChefStationDay } from "../types";
import { modelName, money } from "./format";

/** The most a mod may read in one `$.fs.read`. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;
/** A first scan of thirteen weeks of transcripts can take a while. */
export const SCAN_TIMEOUT_MS = 10 * 60_000;

/** What a scan tallied, from the Node helper or from the mod's own reads. */
export type Tallied = {
  days: Record<string, ChefStationDay>;
  unpricedModels: string[];
  files: number;
  /** Transcripts over 4 MiB that the mod could not read itself. */
  skippedFiles: number;
  /** Transcripts whose read failed; absent from helpers older than 0.3.1. */
  unreadableFiles?: number;
};

/** Turns a tally into the backfill the ledger keeps, with models named as people say them. */
export function toBackfill(tallied: Tallied, source: ChefStationBackfill["source"], scannedAt: number): ChefStationBackfill {
  return {
    days: Object.fromEntries(Object.entries(tallied.days).map(([key, day]) => [key, withModelNames(day)])),
    scannedAt,
    source,
    files: tallied.files,
    skippedFiles: tallied.skippedFiles,
    unreadableFiles: tallied.unreadableFiles ?? 0,
    unpricedModels: tallied.unpricedModels,
  };
}

/** A line saying what a scan found, for `/chef backfill` and the activity station. */
export function describeBackfill(backfill: ChefStationBackfill): string {
  const usd = Object.values(backfill.days).reduce((sum, day) => sum + day.usd, 0);
  const files = `${backfill.files} ${backfill.files === 1 ? "transcript" : "transcripts"}`;
  const notes = [
    `Read ${files}${backfill.source === "node" ? " with Node" : ""}: ${money(usd)} across ${Object.keys(backfill.days).length} days.`,
  ];

  if (backfill.skippedFiles > 0) {
    notes.push(`${backfill.skippedFiles} over 4 MiB were skipped; install Node to include them.`);
  }

  if ((backfill.unreadableFiles ?? 0) > 0) {
    notes.push(`Incomplete: ${backfill.unreadableFiles} could not be read, so their usage is missing.`);
  }

  if (backfill.unpricedModels.length > 0) {
    notes.push(`No price for ${backfill.unpricedModels.join(", ")}; their tokens count but their cost does not.`);
  }

  return notes.join(" ");
}

function withModelNames(day: ChefStationDay): ChefStationDay {
  const models: Record<string, number> = {};

  for (const [id, usd] of Object.entries(day.models)) {
    const name = modelName(id);
    models[name] = (models[name] ?? 0) + usd;
  }

  return { ...day, models };
}
