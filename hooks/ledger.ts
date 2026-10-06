import type { ChefStationDay, ChefStationLedger } from "../types";

/** How far back the ledger remembers: the thirteen weeks the activity grid shows. */
export const WEEKS = 13;
const DAY_MS = 86_400_000;

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

/** The local calendar date of a moment, as `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}-${month}-${day}`;
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

  return prune({ version: 1, days: { ...ledger.days, [key]: day } }, turn.at);
}

function addTo(record: Record<string, number>, name: string, usd: number): Record<string, number> {
  return { ...record, [name]: (record[name] ?? 0) + usd };
}

function prune(ledger: ChefStationLedger, now: number): ChefStationLedger {
  const oldest = dayKey(startOfDay(now, WEEKS * 7));
  const days = Object.fromEntries(Object.entries(ledger.days).filter(([key]) => key > oldest));

  return { version: 1, days };
}

export function today(ledger: ChefStationLedger, now: number): ChefStationDay {
  return ledger.days[dayKey(now)] ?? emptyDay();
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
    const tokens = ledger.days[key]?.tokens ?? 0;
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
  const isActive = (daysBack: number) => (ledger.days[dayKey(startOfDay(now, daysBack))]?.tokens ?? 0) > 0;
  let daysBack = isActive(0) ? 0 : 1;
  let count = 0;

  while (daysBack <= WEEKS * 7 && isActive(daysBack)) {
    count += 1;
    daysBack += 1;
  }

  return count;
}
