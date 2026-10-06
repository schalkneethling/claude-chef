// Reads Claude Code's session transcripts (~/.claude/projects/**/*.jsonl) and
// tallies what each day cost. Plain JavaScript so the mod and the Node helper
// in scripts/backfill.mjs share one implementation.

/**
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number }} EntryUsage
 * @typedef {{ id: string, at: number, sessionId: string, project: string, model: string, isFast: boolean, usage: EntryUsage }} Entry
 * @typedef {{ usd: number, tokens: number, cacheReadTokens: number, inputTokens: number, hours: number[], models: Record<string, number>, projects: Record<string, number> }} Day
 * @typedef {{ days: Record<string, Day>, unpricedModels: string[], responses: number }} TallyResult
 */

/**
 * US dollars per million tokens, first-party API list prices. Cache writes
 * cost 1.25x input for the five-minute TTL and 2x input for the one-hour TTL.
 * The first pattern that matches a model id wins, so specific ids come first.
 */
const PRICES = [
  { pattern: /^claude-(fable|mythos)-5-1/, input: 10, output: 50, cacheRead: 0.25 },
  { pattern: /^claude-(fable|mythos)-5/, input: 10, output: 50, cacheRead: 1 },
  { pattern: /^claude-opus-5-5/, input: 4, output: 20, cacheRead: 0.2 },
  { pattern: /^claude-opus-(5|4-8|4-7|4-6|4-5)/, input: 5, output: 25, cacheRead: 0.5 },
  { pattern: /^claude-opus-4|^claude-3-opus/, input: 15, output: 75, cacheRead: 1.5 },
  { pattern: /^claude-sonnet-5/, input: 2, output: 10, cacheRead: 0.2 },
  { pattern: /^claude-sonnet-4|^claude-3-[57]-sonnet/, input: 3, output: 15, cacheRead: 0.3 },
  { pattern: /^claude-haiku-4-5/, input: 1, output: 5, cacheRead: 0.1 },
  { pattern: /^claude-3-5-haiku/, input: 0.8, output: 4, cacheRead: 0.08 },
];

/** Fast mode runs the same model at twice the price. */
const FAST_MULTIPLIER = 2;

/**
 * One transcript line as a priced response, or undefined for every other line.
 * Claude Code writes a response once per content block, so the same `id` can
 * appear on several lines; the tally counts it once.
 *
 * @param {string} line
 * @returns {Entry | undefined}
 */
export function readLine(line) {
  // Most lines are prompts, tool results and content; skip them before parsing.
  if (!line.includes('"usage"') || !line.includes('"assistant"')) {
    return undefined;
  }

  let record;

  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }

  const message = record?.message;
  const usage = message?.usage;

  if (record.type !== "assistant" || !usage || typeof message.model !== "string" || message.model === "<synthetic>") {
    return undefined;
  }

  const at = Date.parse(record.timestamp);

  if (Number.isNaN(at)) {
    return undefined;
  }

  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const byTtl = usage.cache_creation;
  const cacheWrite1h = byTtl?.ephemeral_1h_input_tokens ?? 0;
  const cacheWrite5m = byTtl ? (byTtl.ephemeral_5m_input_tokens ?? 0) : cacheWrite;

  return {
    id: `${message.id}:${record.requestId}`,
    at,
    sessionId: String(record.sessionId ?? ""),
    project: basename(String(record.cwd ?? "")) || "unknown",
    model: message.model,
    isFast: usage.speed === "fast",
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite5m,
      cacheWrite1h,
    },
  };
}

/**
 * What a response cost in US dollars, or undefined when the model has no known price.
 *
 * @param {Entry} entry
 * @returns {number | undefined}
 */
export function costOf(entry) {
  const price = PRICES.find((candidate) => candidate.pattern.test(entry.model));

  if (!price) {
    return undefined;
  }

  const { input, output, cacheRead, cacheWrite5m, cacheWrite1h } = entry.usage;
  const perMillion =
    input * price.input +
    output * price.output +
    cacheRead * price.cacheRead +
    cacheWrite5m * price.input * 1.25 +
    cacheWrite1h * price.input * 2;

  return (perMillion / 1_000_000) * (entry.isFast ? FAST_MULTIPLIER : 1);
}

/**
 * Adds responses up by local calendar day, hour, model id and project.
 *
 * @param {{ since: number, excludeSessions?: Iterable<string> }} options
 *   `since`: responses before this moment are left out; `excludeSessions`:
 *   sessions the tray already recorded live, so they are not counted twice
 */
export function createTally({ since, excludeSessions = [] }) {
  const excluded = new Set(excludeSessions);
  const seen = new Set();
  const unpriced = new Set();
  /** @type {Record<string, Day>} */
  const days = {};
  let responses = 0;

  return {
    /** @param {Entry | undefined} entry */
    add(entry) {
      if (!entry || entry.at < since || excluded.has(entry.sessionId) || seen.has(entry.id)) {
        return;
      }

      seen.add(entry.id);
      responses += 1;

      const usd = costOf(entry);

      if (usd === undefined) {
        unpriced.add(entry.model);
      }

      const cost = usd ?? 0;
      const { input, output, cacheRead, cacheWrite5m, cacheWrite1h } = entry.usage;
      const inputTokens = input + cacheRead + cacheWrite5m + cacheWrite1h;
      const key = dayKey(entry.at);
      const day = (days[key] ??= emptyDay());

      day.usd += cost;
      day.tokens += inputTokens + output;
      day.cacheReadTokens += cacheRead;
      day.inputTokens += inputTokens;
      const hour = new Date(entry.at).getHours();
      day.hours[hour] = (day.hours[hour] ?? 0) + cost;
      day.models[entry.model] = (day.models[entry.model] ?? 0) + cost;
      day.projects[entry.project] = (day.projects[entry.project] ?? 0) + cost;
    },

    /** @returns {TallyResult} */
    result() {
      return { days, unpricedModels: [...unpriced].sort(), responses };
    },
  };
}

/**
 * Adds one transcript's responses to a tally, but only once the whole file
 * has been read: a file that fails partway adds nothing, rather than part of
 * its usage.
 *
 * @param {AsyncIterable<string> | Iterable<string>} lines
 * @param {{ add: (entry: Entry | undefined) => void }} tally
 * @returns {Promise<boolean>} whether the file was read to its end
 */
export async function addTranscript(lines, tally) {
  /** @type {Entry[]} */
  const staged = [];

  try {
    for await (const line of lines) {
      const entry = readLine(line);

      if (entry) {
        staged.push(entry);
      }
    }
  } catch {
    return false;
  }

  for (const entry of staged) {
    tally.add(entry);
  }

  return true;
}

/** @returns {Day} */
function emptyDay() {
  return { usd: 0, tokens: 0, cacheReadTokens: 0, inputTokens: 0, hours: new Array(24).fill(0), models: {}, projects: {} };
}

/**
 * The local calendar date of a moment, as `YYYY-MM-DD`.
 *
 * @param {number} ms
 */
export function dayKey(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}-${month}-${day}`;
}

/** @param {string} path */
function basename(path) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
