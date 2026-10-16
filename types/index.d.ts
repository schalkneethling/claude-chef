/**
 * The six stations of the sidebar, one per button of its header.
 */
export type ChefStationName = "usage" | "trend" | "breakdown" | "activity" | "context" | "agents";

/** One row of the context window's breakdown, as /context lists it. */
export type ChefStationContextCategory = {
  name: string;
  tokens: number;
  /** `used` fills the window, `free` is what is left, `buffer` the compaction reserve, `deferred` schemas outside the window. */
  kind: "used" | "free" | "buffer" | "deferred";
};

export type ChefStationContextAction = {
  isRunning: boolean;
  isConfirmingClear: boolean;
  message?: string;
};

/** The context window broken down by category, as the last measurement found it. */
export type ChefStationContext = {
  categories: ChefStationContextCategory[];
  /** Tokens in use. */
  totalTokens: number;
  /** The window measured against: the model's limit, or a smaller compaction window. */
  maxTokens: number;
};

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
 * Every day the sidebar remembers, keyed `YYYY-MM-DD`; kept in `$.store` so it
 * outlives the session, and pruned to the last thirteen weeks.
 */
export type ChefStationLedger = {
  version: 1;
  /** What the sidebar recorded live, turn by turn. */
  days: Record<string, ChefStationDay>;
  /** Sessions the sidebar recorded live, with the last day it saw each, so a backfill skips them. */
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

/** How long a prompt-cache entry lives after the request that last read or wrote it. */
export type ChefStationCacheTtl = "5m" | "1h";

/** What the sidebar knows about the main conversation's prompt cache. */
export type ChefStationCache = {
  /** When the main conversation's last model request started, in milliseconds since the epoch. */
  lastRequestAt?: number;
  /** The lifetime of the latest cache write, as the transcript records it; unknown until a turn ends. */
  ttl?: ChefStationCacheTtl;
};

/** Where a Claude Code session runs: the desktop app, a terminal, or in the background. */
export type ChefStationAgentSurface = "desktop" | "terminal" | "background";

/** What a session's own registry entry says it is doing. */
export type ChefStationAgentStatus = "busy" | "idle" | "unknown";

/** A session's latest assistant step: a tool call it made, or text it wrote. */
export type ChefStationAgentAction = { kind: "tool" | "reply"; text: string };

/** One live Claude Code session on this machine, as the Agents station lists it. */
export type ChefStationAgent = {
  pid: number;
  sessionId: string;
  name: string;
  /** The conversation's title (one the person set, else Claude's), when it differs from `name`. */
  title?: string;
  surface: ChefStationAgentSurface;
  /** The last folder of the session's working directory. */
  project: string;
  status: ChefStationAgentStatus;
  /** The person's most recent prompt in that session. */
  lastPrompt?: string;
  lastAction?: ChefStationAgentAction;
  /** When the session last wrote a prompt or a response, in milliseconds since the epoch. */
  lastActivityAt?: number;
  /** When the session began, in milliseconds since the epoch. */
  startedAt?: number;
};

/** Every live session on this machine, as the last look at `~/.claude/sessions` found them. */
export type ChefStationAgents = {
  agents: ChefStationAgent[];
  /** When the list was last refreshed, in milliseconds since the epoch; 0 before the first refresh. */
  refreshedAt: number;
  /** Why the last refresh failed; the agents are then the previous refresh's. */
  error?: string;
};

declare module "claude-code" {
  interface PluginState {
    "chef-station": {
      /** The station the sidebar shows. */
      station: ChefStationName;
      /** The persisted ledger, mirrored here so the sidebar redraws when it moves. */
      ledger: ChefStationLedger;
      /** This session's live figures. */
      live: ChefStationLive | null;
      /** The time the sidebar last ticked, so countdowns move without a turn. */
      now: number;
      /** The session cost already written to the ledger, so no turn counts twice. */
      recordedUsd: number;
      /** The main conversation's prompt cache: when it was last used, and how long its entries live. */
      cache: ChefStationCache;
      /** The context window by category, refreshed after each turn; null before the first measurement. */
      context: ChefStationContext | null;
      /** The Context station's Clear and Compact: whether one is running, whether Clear awaits confirmation, and what the last one said. */
      contextAction: ChefStationContextAction;
      /** Whether a scan of the transcripts is running, and what the last one said. */
      backfillStatus: { isRunning: boolean; message?: string };
      /** Every live Claude Code session on this machine, refreshed while the Agents station shows. */
      agents: ChefStationAgents;
      /** Whether the person closed the sidebar, so a reload does not open it again until they type /chef. */
      isSidebarClosed: boolean;
    };
  }
}
