import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, SessionMeasureInput, SessionUsage, Timer } from "claude-code";

import type {
  ChefStationBackfill,
  ChefStationCache,
  ChefStationContext,
  ChefStationContextAction,
  ChefStationLedger,
  ChefStationLive,
  ChefStationName,
} from "../types";
import { cacheTtlFromTranscript } from "./cache";
import { describeBackfill, MAX_READ_BYTES, SCAN_TIMEOUT_MS, type Tallied, toBackfill } from "./backfill";
import { modelName, short } from "./format";
import { backfillSince, composeLedger, dayKey, emptyLedger, isStale, recordTurn } from "./ledger";
import { STATIONS, tray } from "./stations";
import { addTranscript, createTally } from "./transcript.mjs";

/**
 * Each session stores its own turns under `turns:<session id>`, and the tray
 * adds every session's up when it reads them, so two sessions never write
 * the same key. `$.store` has no conditional write to make a shared key safe.
 */
const SESSION_KEY_PREFIX = "turns:";
/** The last scan of the transcripts, which any session may replace whole. */
const BACKFILL_KEY = "backfill";
/** The single shared ledger of version 0.2.0, still read so its turns are not lost. */
const LEGACY_LEDGER_KEY = "ledger";
const STATION_KEY = "station";
/** Countdowns and other sessions' spending move while this one is idle. */
const TICK_MS = 60_000;
/** The turn's stopwatch moves every second while a turn runs. */
const TURN_TICK_MS = 1_000;
/** The daily scan waits until the session has settled in. */
const SCAN_DELAY_MS = 5_000;

// Held by the host, so the tray survives a hot reload of this file.
const station = atom({ plugin: "chef-station", key: "station" } as const, "usage" as ChefStationName);
const ledger = atom({ plugin: "chef-station", key: "ledger" } as const, emptyLedger());
const live = atom({ plugin: "chef-station", key: "live" } as const, null as ChefStationLive | null);
const now = atom({ plugin: "chef-station", key: "now" } as const, 0);
const recordedUsd = atom({ plugin: "chef-station", key: "recordedUsd" } as const, 0);
const cache = atom({ plugin: "chef-station", key: "cache" } as const, {} as ChefStationCache);
const contextBreakdown = atom({ plugin: "chef-station", key: "context" } as const, null as ChefStationContext | null);
const contextAction = atom({ plugin: "chef-station", key: "contextAction" } as const, {
  isRunning: false,
  isConfirmingClear: false,
} as ChefStationContextAction);
const backfillStatus = atom({ plugin: "chef-station", key: "backfillStatus" } as const, { isRunning: false } as {
  isRunning: boolean;
  message?: string;
});

export const register: Register = (on, options) => {
  const plan = typeof options.plan === "string" && options.plan.trim() !== "" ? options.plan.trim() : undefined;

  // Turns that complete together (a subagent and its parent) are recorded one
  // at a time, so neither reads the session cost the other is about to claim.
  let recording: Promise<unknown> = Promise.resolve();
  let turnTicker: Timer | undefined;

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    const usage = await $.session.usage();
    const root = await $.session.root();
    const model = modelName(await $.session.model());
    const saved = await $.store.get(STATION_KEY);

    await update($, live, () => ({
      project: basename(root),
      model,
      outputTokens: 0,
      usd: usage.cost?.usd ?? 0,
      startedAt: usage.startedAt,
      contextPercent: usage.context.percent,
      rateLimits: [...usage.rateLimits],
    }));
    // Whatever the session cost before this load is already in the ledger, or predates the tray.
    await update($, recordedUsd, () => usage.cost?.usd ?? 0);
    await tick($);
    await refreshContext($).catch(() => undefined);

    if (isStation(saved)) {
      await update($, station, () => saved);
    }

    await $.command.register({
      name: "chef",
      description: "Show a station of the chef tray, or rescan your Claude Code history with backfill.",
      argumentHint: "[usage|trend|breakdown|activity|context|backfill]",
      immediate: true,
    });

    $.clock.every(TICK_MS, () => {
      tick($).catch(() => undefined);
    });

    // Fill in the history from Claude Code's transcripts once a day, in the background.
    const stored = await read($, ledger);
    const at = await $.clock.now();

    if (!stored.backfill || dayKey(stored.backfill.scannedAt) !== dayKey(at)) {
      $.clock.after(SCAN_DELAY_MS, () => {
        runBackfill($).catch(() => undefined);
      });
    }

    return result;
  });

  // Every model request is a step. A request reads or writes the prompt cache and restarts its
  // lifetime from the moment it starts, so the main conversation's steps start the countdown.
  on("turn.step", async function* ($, e, next) {
    if (!e.agentId) {
      const at = await $.clock.now();
      await update($, cache, (before) => ({ ...before, lastRequestAt: at }));
    }

    return yield* next(e);
  });

  // The settings hooks' Stop fires as the main conversation's turn ends and names its transcript,
  // whose latest cache write says whether the cache lives for five minutes or an hour.
  on("classic.Stop", async ($, e, next) => {
    const result = await next(e);
    const ttl = cacheTtlFromTranscript(await readTranscriptTail($, e.transcript_path));

    if (ttl) {
      await update($, cache, (before) => ({ ...before, ttl }));
    }

    return result;
  });

  // A /clear raises no session.start: the conversation ends here, its cost starts over from nothing,
  // and the new conversation has no cache yet.
  on("session.end", async ($, e, next) => {
    const result = await next(e);

    if (e.reason === "clear") {
      await update($, recordedUsd, () => 0);
      // The breakdown on screen is the previous conversation's; the next turn measures the new one.
      await update($, contextBreakdown, () => null);
      await update($, cache, () => ({}));
    }

    return result;
  });

  // Raised for the main conversation's turns only; subagents' runs raise none.
  on("turn.start", async ($, e, next) => {
    const at = await $.clock.now();
    // Read again each turn, so a /model switch shows before the turn completes.
    const model = modelName(await $.session.model());
    await update($, live, (before) => (before === null ? before : { ...before, model, turnStartedAt: at }));
    await update($, now, () => at);

    turnTicker?.cancel();
    turnTicker = $.clock.every(TURN_TICK_MS, () => {
      $.clock
        .now()
        .then((moment) => update($, now, () => moment))
        .catch(() => undefined);
    });

    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    await applyMeasure($, e);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);

    if (!e.agentId) {
      turnTicker?.cancel();
      turnTicker = undefined;
      await update($, live, (before) =>
        before === null ? before : { ...before, turnStartedAt: undefined, lastTurnMs: e.durationMs },
      );
    }

    recording = recording.then(async () => {
      const usage = await $.session.usage();
      const totalUsd = usage.cost?.usd ?? 0;
      const alreadyRecorded = await read($, recordedUsd);
      // A total below what was recorded means the session's cost started over (a /clear): all of it is new.
      const usd = totalUsd < alreadyRecorded ? totalUsd : totalUsd - alreadyRecorded;
      const current = await read($, live);
      const model = e.usage ? modelName(e.usage.model) : current?.model ?? "—";

      if (usd === 0 && !e.usage) {
        return;
      }

      const at = await $.clock.now();
      const sessionId = await $.session.id();
      const sessionKey = `${SESSION_KEY_PREFIX}${sessionId}`;
      const own = asLedger(await $.store.get(sessionKey));
      const recorded = recordTurn(own, {
        at,
        usd,
        model,
        project: current?.project ?? "unknown",
        sessionId,
        usage: e.usage && {
          input: e.usage.input_tokens,
          output: e.usage.output_tokens,
          cacheRead: e.usage.cache_read_input_tokens,
          cacheCreation: e.usage.cache_creation_input_tokens,
        },
      });

      await $.store.set(sessionKey, recorded);
      await refreshLedger($);
      await update($, recordedUsd, () => totalUsd);
      await update($, live, (before) => ({
        ...(before ?? { project: "unknown", model, outputTokens: 0, usd: 0, startedAt: at, rateLimits: [] }),
        // The "Now" row names the main conversation's model, not a subagent's.
        model: e.agentId && before ? before.model : model,
        outputTokens: (before?.outputTokens ?? 0) + (e.usage?.output_tokens ?? 0),
        usd: totalUsd,
        contextPercent: usage.context.percent,
        rateLimits: [...usage.rateLimits],
      }));
      await update($, now, () => at);
    });

    await recording.catch(() => undefined);

    // The window changes with every turn of the main conversation; a subagent has its own.
    if (!e.agentId) {
      await refreshContext($).catch(() => undefined);
    }

    return result;
  });

  on("command.run", { command: "chef" }, async ($, e) => {
    const asked = e.args.trim().toLowerCase();

    if (asked === "backfill") {
      return { text: await runBackfill($) };
    }

    if (asked === "") {
      const current = await read($, station);
      const index = STATIONS.findIndex((entry) => entry.name === current);
      const following = STATIONS[(index + 1) % STATIONS.length]!.name;
      await select($, following);
      return { text: `Chef tray: ${following}` };
    }

    if (!isStation(asked)) {
      return {
        text: `No station called "${asked}". Try ${STATIONS.map((entry) => entry.name).join(", ")}, or backfill to rescan your history.`,
      };
    }

    await select($, asked);
    return { text: `Chef tray: ${asked}` };
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e);
    }

    const currentLive = await read($, live);
    const currentLedger = await read($, ledger);
    const currentNow = await read($, now);

    // Nothing to show before the session has started.
    if (currentLive === null) {
      return next(e);
    }

    const ui = $.ui.resolve(e);

    return tray({
      ui,
      station: await read($, station),
      ledger: currentLedger,
      live: currentLive,
      now: currentNow || currentLive.startedAt,
      plan,
      backfillStatus: await read($, backfillStatus),
      cache: await read($, cache),
      context: await read($, contextBreakdown),
      contextAction: await read($, contextAction),
      onContextAction: (action) => void runContextAction($, action),
      isWorking: e.props.isWorking,
      columns: e.props.bodyColumns,
      onSelect: (name) => void select($, name),
    });
  });
};

/**
 * Scans Claude Code's transcripts for every session the tray did not record
 * live and stores the result beside the live turns. Returns a line saying how
 * it went, for `/chef backfill` and the activity station.
 */
async function runBackfill($: EngineInterface): Promise<string> {
  const status = await read($, backfillStatus);

  if (status.isRunning) {
    return "Already reading your Claude Code history.";
  }

  await update($, backfillStatus, () => ({ isRunning: true, message: status.message }));
  let message: string;

  try {
    const at = await $.clock.now();
    const before = await loadLedger($);
    const options = {
      since: backfillSince(at),
      excludeSessions: [...Object.keys(before.liveSessions ?? {}), await $.session.id()],
    };
    const projects = await projectsDirectory($);
    const viaNode = await scanWithNode($, projects, options);
    const backfill = toBackfill(viaNode ?? (await scanWithFs($, projects, options)), viaNode ? "node" : "fs", at);

    await $.store.set(BACKFILL_KEY, backfill);
    await refreshLedger($);
    message = describeBackfill(backfill);
  } catch (error) {
    message = `Could not read your Claude Code history: ${error instanceof Error ? error.message : String(error)}`;
  }

  await update($, backfillStatus, () => ({ isRunning: false, message }));
  return message;
}

type ScanOptions = { since: number; excludeSessions: string[] };

async function projectsDirectory($: EngineInterface): Promise<string> {
  const configured = await $.env.get("CLAUDE_CONFIG_DIR");

  if (configured) {
    return `${configured}/projects`;
  }

  const home = (await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE")) ?? "";
  return `${home}/.claude/projects`;
}

/** The Node helper streams transcripts of any size; a mod may read 4 MiB at most. */
async function scanWithNode($: EngineInterface, projects: string, options: ScanOptions): Promise<Tallied | undefined> {
  try {
    const { exitCode, stdout, isStdoutTruncated } = await $.process.run(
      ["node", `${$.plugin.root}/scripts/backfill.mjs`, "--projects", projects, "--since", String(options.since)],
      { stdin: JSON.stringify(options.excludeSessions), timeoutMs: SCAN_TIMEOUT_MS },
    );

    if (exitCode !== 0 || isStdoutTruncated) {
      return undefined;
    }

    return JSON.parse(stdout) as Tallied;
  } catch {
    // Node is not installed, or the scan could not finish: read the files directly instead.
    return undefined;
  }
}

async function scanWithFs($: EngineInterface, projects: string, options: ScanOptions): Promise<Tallied> {
  const tally = createTally(options);
  let files = 0;
  let skippedFiles = 0;
  let unreadableFiles = 0;

  for (const file of await listTranscripts($, projects)) {
    files += 1;

    if (file.size > MAX_READ_BYTES) {
      skippedFiles += 1;
      continue;
    }

    let text: string;

    try {
      text = await $.fs.read(file.path);
    } catch {
      // Counted apart from the size-limited skips, so the backfill can say it is incomplete.
      unreadableFiles += 1;
      continue;
    }

    await addTranscript(text.split("\n"), tally);
  }

  return { ...tally.result(), files, skippedFiles, unreadableFiles };
}

/** Every .jsonl file under `directory`, subagent transcripts included. */
async function listTranscripts($: EngineInterface, directory: string): Promise<{ path: string; size: number }[]> {
  const entries = await $.fs.list(directory).catch(() => []);
  const found: { path: string; size: number }[] = [];

  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;

    if (entry.kind === "dir") {
      found.push(...(await listTranscripts($, path)));
    } else if (entry.kind === "file" && entry.name.endsWith(".jsonl")) {
      found.push({ path, size: entry.size });
    }
  }

  return found;
}

/** How much of a transcript's end is enough to find the latest response that wrote the cache. */
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

/**
 * The end of a transcript: the whole file when the mod may read it (4 MiB at
 * most), otherwise its last megabyte through `tail`. Empty when neither works,
 * which leaves the lifetime as it was.
 */
async function readTranscriptTail($: EngineInterface, path: string): Promise<string> {
  try {
    const { size } = await $.fs.stat(path);

    if (size <= MAX_READ_BYTES) {
      return await $.fs.read(path);
    }

    const { exitCode, stdout } = await $.process.run(["tail", "-c", String(TRANSCRIPT_TAIL_BYTES), path]);
    return exitCode === 0 ? stdout : "";
  } catch {
    return "";
  }
}

/** Shows a station, remembers it for the next session, and measures the context when that station opens. */
async function select($: EngineInterface, name: ChefStationName) {
  await update($, station, () => name);
  await $.store.set(STATION_KEY, name);

  if (name === "context") {
    await refreshContext($).catch(() => undefined);
  }
}

/** What the Context station's Compact and Clear buttons, and Clear's confirmation, do. */
async function runContextAction($: EngineInterface, action: "compact" | "clear" | "confirm-clear" | "cancel-clear") {
  if (action === "clear") {
    await update($, contextAction, (before) => ({ ...before, isConfirmingClear: true, message: undefined }));
    return;
  }

  if (action === "cancel-clear") {
    await update($, contextAction, (before) => ({ ...before, isConfirmingClear: false }));
    return;
  }

  // Two quick presses can both arrive before the redraw hides the buttons. Claiming the
  // running flag in one read-and-write lets only the first of them start the action.
  let isClaimed = false;
  await update($, contextAction, (before) => {
    isClaimed = !before.isRunning;
    return isClaimed ? { isRunning: true, isConfirmingClear: false } : before;
  });

  if (!isClaimed) {
    return;
  }

  let message: string | undefined;

  try {
    if (action === "compact") {
      const result = await $.session.compact();

      if (result.skip !== undefined) {
        message = `Compacting was skipped: ${result.skip}`;
      } else if (result.tokensBefore !== undefined && result.tokensAfter !== undefined) {
        message = `Compacted from ${short(result.tokensBefore)} to ${short(result.tokensAfter)} tokens.`;
      } else {
        message = "Compacted.";
      }
    } else {
      // There is no call for this on $; the button runs /clear as if it were typed.
      await $.command.run({ command: "clear" });
      message = "Cleared. A new conversation has started.";
    }
  } catch (error) {
    message = `Could not ${action === "compact" ? "compact" : "clear"}: ${error instanceof Error ? error.message : String(error)}`;
  }

  await update($, contextAction, () => ({ isRunning: false, isConfirmingClear: false, message }));
  await refreshContext($).catch(() => undefined);
}

/**
 * Measures the context window by category, as /context does. The `summary`
 * level estimates locally and sends no token-count requests, so it is cheap
 * enough to run after every turn.
 */
async function refreshContext($: EngineInterface) {
  const { context } = await $.session.usage({ breakdown: "summary" });
  const breakdown = context.breakdown;

  if (!breakdown) {
    return;
  }

  const measured: ChefStationContext = {
    categories: breakdown.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })),
    totalTokens: breakdown.totalTokens,
    maxTokens: breakdown.rawMaxTokens,
  };

  await update($, contextBreakdown, () => measured);
}

/** Moves the tray's clock on and picks up what other sessions have recorded. */
async function tick($: EngineInterface) {
  const at = await $.clock.now();
  await update($, now, () => at);
  await refreshLedger($);
}

async function refreshLedger($: EngineInterface) {
  const composed = await loadLedger($);
  await update($, ledger, () => composed);
}

/**
 * Every session's turns and the last scan, read from the store and added up.
 * A session whose days have all fallen out of the thirteen weeks is deleted
 * on the way, so the store does not grow without end.
 */
async function loadLedger($: EngineInterface): Promise<ChefStationLedger> {
  const at = await $.clock.now();
  const sessions: Record<string, ChefStationLedger> = {};

  for (const key of await $.store.keys()) {
    if (!key.startsWith(SESSION_KEY_PREFIX) && key !== LEGACY_LEDGER_KEY) {
      continue;
    }

    const part = asLedger(await $.store.get(key));

    if (isStale(part, at)) {
      await $.store.delete(key);
    } else {
      sessions[key] = part;
    }
  }

  const backfill = asBackfill(await $.store.get(BACKFILL_KEY)) ?? sessions[LEGACY_LEDGER_KEY]?.backfill;
  return composeLedger(sessions, backfill, at);
}

async function applyMeasure($: EngineInterface, e: SessionMeasureInput | SessionUsage) {
  await update($, live, (before) =>
    before === null
      ? before
      : {
          ...before,
          usd: e.cost?.usd ?? before.usd,
          contextPercent: e.context.percent ?? before.contextPercent,
          rateLimits: [...e.rateLimits],
        },
  );
}

function asLedger(value: unknown): ChefStationLedger {
  const isLedger =
    typeof value === "object" && value !== null && (value as ChefStationLedger).version === 1 && typeof (value as ChefStationLedger).days === "object";

  return isLedger ? (value as ChefStationLedger) : emptyLedger();
}

function asBackfill(value: unknown): ChefStationBackfill | undefined {
  const isBackfill = typeof value === "object" && value !== null && typeof (value as ChefStationBackfill).days === "object";
  return isBackfill ? (value as ChefStationBackfill) : undefined;
}

function isStation(value: unknown): value is ChefStationName {
  return STATIONS.some((entry) => entry.name === value);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
