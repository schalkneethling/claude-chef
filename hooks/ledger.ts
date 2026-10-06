import type { ChefStationBackfill, ChefStationDay, ChefStationLedger } from "../types";
import { dayKey } from "./transcript.mjs";

export { dayKey };

/** How far back the ledger remembers: the thirteen weeks the activity grid shows. */
export const WEEKS = 13;

export type TurnUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

export type TurnRecord = {
  /** When the turn completed, in milliseconds since the epoch. */
  at: number;
  /** What the turn cost, in US dollars. */
  usd: number;
  model: string;
  project: string;
  /** The session the turn ran in, so a scan of the transcripts does not count it again. */
  sessionId: string;
  usage?: TurnUsage;
};

export type Ranked = { name: string; usd: number };

export type Activity = {
  /** Thirteen columns of Monday to Sunday; `null` for a day still ahead. */
  weeks: (number | null)[][];
  totalTokens: number;
  activeDays: number;
  busiest?: { key: string; tokens: number };
  /** Consecutive active days up to today, or up to yesterday before today's first turn. */
  streak: number;
};

export function emptyLedger(): ChefStationLedger {
  return { version: 1, days: {} };
}

function emptyDay(): ChefStationDay {
  return {
    usd: 0,
    tokens: 0,
    cacheReadTokens: 0,
    inputTokens: 0,
    hours: new Array(24).fill(0),
    models: {},
    projects: {},
  };
}

/** Midnight, local time, `days` days before the day of `ms`. */
function startOfDay(ms: number, daysBack = 0): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysBack).getTime();
}

/**
 * Adds one completed turn to the ledger and drops the days that have fallen
 * out of the thirteen weeks. Returns a new ledger; the one passed in is left as it was.
 */
export function recordTurn(ledger: ChefStationLedger, turn: TurnRecord): ChefStationLedger {
  const key = dayKey(turn.at);
  const before = ledger.days[key] ?? emptyDay();
  const usage = turn.usage ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const inputTokens = usage.input + usage.cacheRead + usage.cacheCreation;
  const hour = new Date(turn.at).getHours();
  const hours = before.hours.map((usd, index) => (index === hour ? usd + turn.usd : usd));

  const day: ChefStationDay = {
    usd: before.usd + turn.usd,
    tokens: before.tokens + inputTokens + usage.output,
    cacheReadTokens: before.cacheReadTokens + usage.cacheRead,
    inputTokens: before.inputTokens + inputTokens,
    hours,
    models: addTo(before.models, turn.model, turn.usd),
    projects: addTo(before.projects, turn.project, turn.usd),
  };

  return prune(
    {
      ...ledger,
      days: { ...ledger.days, [key]: day },
      liveSessions: { ...ledger.liveSessions, [turn.sessionId]: key },
    },
    turn.at,
  );
}

/** Puts a fresh scan of the transcripts in place of the last one. */
export function withBackfill(ledger: ChefStationLedger, backfill: ChefStationBackfill): ChefStationLedger {
  return prune({ ...ledger, backfill }, backfill.scannedAt);
}

/** The earliest moment a scan needs to read: the first day the ledger keeps. */
export function backfillSince(now: number): number {
  return startOfDay(now, WEEKS * 7 - 1);
}

function addTo(record: Record<string, number>, name: string, usd: number): Record<string, number> {
  return { ...record, [name]: (record[name] ?? 0) + usd };
}

function prune(ledger: ChefStationLedger, now: number): ChefStationLedger {
  const oldest = dayKey(backfillSince(now));
  const isKept = ([key]: [string, unknown]) => key >= oldest;
  const keepDays = (days: Record<string, ChefStationDay>) => Object.fromEntries(Object.entries(days).filter(isKept));
  // Sessions are keyed by id with their last day as the value.
  const liveSessions = Object.fromEntries(Object.entries(ledger.liveSessions ?? {}).filter(([, key]) => key >= oldest));

  return {
    version: 1,
    days: keepDays(ledger.days),
    liveSessions,
    ...(ledger.backfill ? { backfill: { ...ledger.backfill, days: keepDays(ledger.backfill.days) } } : {}),
  };
}

/** One day as the tray shows it: what was recorded live plus what the last scan found. */
function dayOf(ledger: ChefStationLedger, key: string): ChefStationDay | undefined {
  const live = ledger.days[key];
  const scanned = ledger.backfill?.days[key];

  return live && scanned ? addDays(live, scanned) : (live ?? scanned);
}

function addDays(first: ChefStationDay, second: ChefStationDay): ChefStationDay {
  return {
    usd: first.usd + second.usd,
    tokens: first.tokens + second.tokens,
    cacheReadTokens: first.cacheReadTokens + second.cacheReadTokens,
    inputTokens: first.inputTokens + second.inputTokens,
    hours: first.hours.map((usd, hour) => usd + (second.hours[hour] ?? 0)),
    models: sumRecords(first.models, second.models),
    projects: sumRecords(first.projects, second.projects),
  };
}

/**
 * The ledger the tray reads, put together from the turns each session stored
 * under a key of its own and the last scan of the transcripts. Each session
 * writing only its own key keeps two sessions from overwriting each other.
 */
export function composeLedger(
  sessions: Record<string, ChefStationLedger>,
  backfill: ChefStationBackfill | undefined,
  now: number,
): ChefStationLedger {
  const days: Record<string, ChefStationDay> = {};
  const liveSessions: Record<string, string> = {};

  for (const part of Object.values(sessions)) {
    for (const [key, day] of Object.entries(part.days)) {
      const before = days[key];
      days[key] = before ? addDays(before, day) : day;
    }

    Object.assign(liveSessions, part.liveSessions);
  }

  return prune({ version: 1, days, liveSessions, ...(backfill ? { backfill } : {}) }, now);
}

/** Whether every day a session stored has fallen out of the thirteen weeks. */
export function isStale(ledger: ChefStationLedger, now: number): boolean {
  return Object.keys(prune(ledger, now).days).length === 0;
}

function sumRecords(first: Record<string, number>, second: Record<string, number>): Record<string, number> {
  return Object.entries(second).reduce((sum, [name, usd]) => addTo(sum, name, usd), first);
}

export function today(ledger: ChefStationLedger, now: number): ChefStationDay {
  return dayOf(ledger, dayKey(now)) ?? emptyDay();
}

export function hourly(ledger: ChefStationLedger, now: number): number[] {
  return today(ledger, now).hours;
}

/** Entries sorted by cost, most expensive first, at most `limit` of them. */
export function ranked(record: Record<string, number>, limit = Infinity): Ranked[] {
  return Object.entries(record)
    .map(([name, usd]) => ({ name, usd }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, limit);
}

export function activity(ledger: ChefStationLedger, now: number): Activity {
  // getDay() counts from Sunday; the grid counts from Monday.
  const weekday = (new Date(now).getDay() + 6) % 7;
  const daysShown = (WEEKS - 1) * 7 + weekday + 1;
  const weeks: (number | null)[][] = Array.from({ length: WEEKS }, () => new Array(7).fill(null));

  let totalTokens = 0;
  let activeDays = 0;
  let busiest: Activity["busiest"];

  for (let index = 0; index < daysShown; index++) {
    const key = dayKey(startOfDay(now, daysShown - 1 - index));
    const tokens = dayOf(ledger, key)?.tokens ?? 0;
    weeks[Math.floor(index / 7)]![index % 7] = tokens;

    if (tokens > 0) {
      totalTokens += tokens;
      activeDays += 1;

      if (busiest === undefined || tokens > busiest.tokens) {
        busiest = { key, tokens };
      }
    }
  }

  return { weeks, totalTokens, activeDays, busiest, streak: streak(ledger, now) };
}

function streak(ledger: ChefStationLedger, now: number): number {
  const isActive = (daysBack: number) => (dayOf(ledger, dayKey(startOfDay(now, daysBack)))?.tokens ?? 0) > 0;
  let daysBack = isActive(0) ? 0 : 1;
  let count = 0;

  while (daysBack <= WEEKS * 7 && isActive(daysBack)) {
    count += 1;
    daysBack += 1;
  }

  return count;
}
