import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, SessionMeasureInput, SessionUsage } from "claude-code";

import type { ChefStationLedger, ChefStationLive, ChefStationName } from "../types";
import { modelName } from "./format";
import { emptyLedger, recordTurn } from "./ledger";
import { STATIONS, tray } from "./stations";

const PLUGIN = "chef-station";
const LEDGER_KEY = "ledger";
const STATION_KEY = "station";
const TICK_MS = 60_000;

// Held by the host, so the tray survives a hot reload of this file.
const station = atom({ plugin: "chef-station", key: "station" } as const, "usage" as ChefStationName);
const ledger = atom({ plugin: "chef-station", key: "ledger" } as const, emptyLedger());
const live = atom({ plugin: "chef-station", key: "live" } as const, null as ChefStationLive | null);
const now = atom({ plugin: "chef-station", key: "now" } as const, 0);
const recordedUsd = atom({ plugin: "chef-station", key: "recordedUsd" } as const, 0);

export const register: Register = (on, options) => {
  const plan = typeof options.plan === "string" && options.plan.trim() !== "" ? options.plan.trim() : undefined;

  // Turns that complete together (a subagent and its parent) are recorded one
  // at a time, so neither reads the session cost the other is about to claim.
  let recording: Promise<unknown> = Promise.resolve();

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    const usage = await $.session.usage();
    const root = await $.session.root();
    const saved = await $.store.get(STATION_KEY);

    await update($, live, () => ({
      project: basename(root),
      model: "—",
      outputTokens: 0,
      usd: usage.cost?.usd ?? 0,
      startedAt: usage.startedAt,
      contextPercent: usage.context.percent,
      rateLimits: [...usage.rateLimits],
    }));
    // Whatever the session cost before this load is already in the ledger, or predates the tray.
    await update($, recordedUsd, () => usage.cost?.usd ?? 0);
    await tick($);

    if (isStation(saved)) {
      await update($, station, () => saved);
    }

    await $.command.register({
      name: "chef",
      description: "Show a station of the chef tray: usage, trend, breakdown or activity.",
      argumentHint: "[usage|trend|breakdown|activity]",
      immediate: true,
    });

    // Countdowns and other sessions' spending move while this one is idle.
    $.clock.every(TICK_MS, () => {
      void tick($);
    });

    return result;
  });

  on("session.measure", async ($, e, next) => {
    await applyMeasure($, e);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);

    recording = recording.then(async () => {
      const usage = await $.session.usage();
      const totalUsd = usage.cost?.usd ?? 0;
      const alreadyRecorded = await read($, recordedUsd);
      const usd = Math.max(0, totalUsd - alreadyRecorded);
      const current = await read($, live);
      const model = e.usage ? modelName(e.usage.model) : current?.model ?? "—";

      if (usd === 0 && !e.usage) {
        return;
      }

      // Read the store fresh: another session may have written since this one last looked.
      const at = await $.clock.now();
      const stored = asLedger(await $.store.get(LEDGER_KEY));
      const recorded = recordTurn(stored, {
        at,
        usd,
        model,
        project: current?.project ?? "unknown",
        usage: e.usage && {
          input: e.usage.input_tokens,
          output: e.usage.output_tokens,
          cacheRead: e.usage.cache_read_input_tokens,
          cacheCreation: e.usage.cache_creation_input_tokens,
        },
      });

      await $.store.set(LEDGER_KEY, recorded);
      await update($, ledger, () => recorded);
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
    return result;
  });

  on("command.run", { command: "chef" }, async ($, e) => {
    const asked = e.args.trim().toLowerCase();

    if (asked === "") {
      const current = await read($, station);
      const index = STATIONS.findIndex((entry) => entry.name === current);
      const following = STATIONS[(index + 1) % STATIONS.length]!.name;
      await select($, following);
      return { text: `Chef tray: ${following}` };
    }

    if (!isStation(asked)) {
      return { text: `No station called "${asked}". Try ${STATIONS.map((entry) => entry.name).join(", ")}.` };
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
      isWorking: e.props.isWorking,
      columns: e.props.bodyColumns,
      onSelect: (name) => void select($, name),
    });
  });
};

async function select($: EngineInterface, name: ChefStationName) {
  await update($, station, () => name);
  await $.store.set(STATION_KEY, name);
}

/** Moves the tray's clock on and picks up what other sessions have recorded. */
async function tick($: EngineInterface) {
  const at = await $.clock.now();
  await update($, now, () => at);
  await refreshLedger($);
}

async function refreshLedger($: EngineInterface) {
  const stored = asLedger(await $.store.get(LEDGER_KEY));
  await update($, ledger, () => stored);
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

function isStation(value: unknown): value is ChefStationName {
  return STATIONS.some((entry) => entry.name === value);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
