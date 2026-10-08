import type { ChefStationCache, ChefStationCacheTtl } from "../types";
import { countdown } from "./format";

const TTL_MS: Record<ChefStationCacheTtl, number> = { "5m": 5 * 60_000, "1h": 60 * 60_000 };

export type CacheStatus = { state: "warm"; remainingMs: number } | { state: "expired" } | { state: "none" };

/**
 * The lifetime of the main conversation's latest prompt-cache write, read from
 * the end of its transcript: `1h` or `5m`, or undefined when no write shows.
 *
 * Responses that only read the cache are skipped, since a read keeps the
 * lifetime its entry was written with. So are subagents' responses, whose
 * cache is their own. A text cut from the middle of a file may begin with a
 * partial line, which does not parse and is skipped too.
 */
export function cacheTtlFromTranscript(text: string): ChefStationCacheTtl | undefined {
  const lines = text.split("\n");

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;

    if (!line.includes('"usage"') || !line.includes('"assistant"')) {
      continue;
    }

    let record;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const usage = record?.message?.usage;

    if (record.type !== "assistant" || record.isSidechain === true || !usage) {
      continue;
    }

    const byTtl = usage.cache_creation;

    if ((byTtl?.ephemeral_1h_input_tokens ?? 0) > 0) {
      return "1h";
    }

    if ((byTtl?.ephemeral_5m_input_tokens ?? 0) > 0) {
      return "5m";
    }

    // Older responses report cache writes without the breakdown; those are five-minute writes.
    if (!byTtl && (usage.cache_creation_input_tokens ?? 0) > 0) {
      return "5m";
    }
  }

  return undefined;
}

/**
 * Whether the main conversation's prompt cache is likely still warm, and for
 * how long. An entry lives for its lifetime from the start of the last request
 * that read or wrote it; with no lifetime known, the shorter five minutes is
 * assumed, so the tray never calls a cold cache warm.
 */
export function cacheStatus(cache: ChefStationCache, now: number): CacheStatus {
  if (cache.lastRequestAt === undefined) {
    return { state: "none" };
  }

  const remainingMs = cache.lastRequestAt + TTL_MS[cache.ttl ?? "5m"] - now;
  return remainingMs > 0 ? { state: "warm", remainingMs } : { state: "expired" };
}

/** The Now row's words for the cache: an estimate while warm, so it says so with a tilde. */
export function cacheLabel(status: CacheStatus): string | undefined {
  if (status.state === "warm") {
    return `cache warm · ${status.remainingMs < 60_000 ? "<1m" : `~${countdown(status.remainingMs)}`} left`;
  }

  return status.state === "expired" ? "cache expired" : undefined;
}
