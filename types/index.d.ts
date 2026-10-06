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
  days: Record<string, ChefStationDay>;
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
    };
  }
}
