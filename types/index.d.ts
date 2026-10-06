/**
 * The four stations of the tray, one per card of the overview.
 */
export type ChefStationName = "usage" | "trend" | "breakdown" | "activity";

/**
 * What one calendar day (local time) has cost, across every session.
 */
export type ChefStationDay = {
  /** US dollars, as `/cost` totals them. */
  usd: number;
  /** Every token the day's turns counted: input, output and both cache kinds. */
  tokens: number;
  /** Input tokens served from the prompt cache. */
  cacheReadTokens: number;
  /** Every input token: uncached, cache reads and cache writes. */
  inputTokens: number;
  /** US dollars per hour of the day, index 0 being midnight to 1am. */
  hours: number[];
  /** US dollars per model display name. */
  models: Record<string, number>;
  /** US dollars per project (the folder the session runs in). */
  projects: Record<string, number>;
};

/**
 * Every day the tray remembers, keyed `YYYY-MM-DD`; kept in `$.store` so it
 * outlives the session, and pruned to the last thirteen weeks.
 */
export type ChefStationLedger = {
  version: 1;
  /** What the tray recorded live, turn by turn. */
  days: Record<string, ChefStationDay>;
  /** Sessions the tray recorded live, with the last day it saw each, so a backfill skips them. */
  liveSessions?: Record<string, string>;
  /** What the last scan of Claude Code's transcripts found, for every other session. */
  backfill?: ChefStationBackfill;
};

/**
 * The days a scan of `~/.claude/projects` tallied. Models are keyed by
 * display name and costs are estimated from list prices, as the transcripts
 * hold token counts and no cost.
 */
export type ChefStationBackfill = {
  days: Record<string, ChefStationDay>;
  /** When the scan finished, in milliseconds since the epoch. */
  scannedAt: number;
  /** `node` when the helper script ran, `fs` when the mod read the files itself. */
  source: "node" | "fs";
  files: number;
  /** Transcripts too large for the mod to read itself (only when Node was not found). */
  skippedFiles: number;
  /** Transcripts whose read failed; the backfill is incomplete when there are any. Absent before 0.3.1. */
  unreadableFiles?: number;
  /** Model ids with no known price; their tokens count but their cost does not. */
  unpricedModels: string[];
};

/**
 * What this session alone is doing right now: the "Now" row.
 */
export type ChefStationLive = {
  project: string;
  model: string;
  /** Output tokens this session's turns generated. */
  outputTokens: number;
  /** This session's cost so far, in US dollars. */
  usd: number;
  /** When the session began, in milliseconds since the epoch. */
  startedAt: number;
  /** When the running turn began; absent while the session is idle. */
  turnStartedAt?: number;
  /** How long the last completed turn took, in milliseconds. */
  lastTurnMs?: number;
  /** The context window's fill, 0 to 100, when a response reported one. */
  contextPercent?: number;
  /** The account's rate-limit windows, as the last response reported them. */
  rateLimits: ChefStationRateLimit[];
};

export type ChefStationRateLimit = {
  kind: string;
  percentUsed: number;
  resetsAt?: string;
};

declare module "claude-code" {
  interface PluginState {
    "chef-station": {
      /** The station the tray shows. */
      station: ChefStationName;
      /** The persisted ledger, mirrored here so the band redraws when it moves. */
      ledger: ChefStationLedger;
      /** This session's live figures. */
      live: ChefStationLive | null;
      /** The time the tray last ticked, so countdowns move without a turn. */
      now: number;
      /** The session cost already written to the ledger, so no turn counts twice. */
      recordedUsd: number;
      /** Whether a scan of the transcripts is running, and what the last one said. */
      backfillStatus: { isRunning: boolean; message?: string };
    };
  }
}
