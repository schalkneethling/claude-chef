import type { Elements, RenderChildren } from "claude-code";

import type { ChefStationCache, ChefStationLedger, ChefStationLive, ChefStationName } from "../types";
import { cacheLabel, cacheStatus } from "./cache";
import { bar, countdown, elapsed, money, short, verticalBars } from "./format";
import { activity, hourly, ranked, today } from "./ledger";

/** The elements a station draws with; the terminal's and the desktop's tables both have them. */
export type Ui = Pick<Elements["terminal"], "Box" | "Text" | "Button">;

export type TrayView = {
  ui: Ui;
  station: ChefStationName;
  ledger: ChefStationLedger;
  live?: ChefStationLive;
  now: number;
  plan?: string;
  /** Whether a scan of the transcripts is running, and what the last one said. */
  backfillStatus?: { isRunning: boolean; message?: string };
  /** The main conversation's prompt cache: when it was last used, and how long its entries live. */
  cache?: ChefStationCache;
  isWorking: boolean;
  columns: number;
  onSelect: (station: ChefStationName) => void;
};

export const STATIONS: { name: ChefStationName; label: string; hotkey: string }[] = [
  { name: "usage", label: "Usage", hotkey: "1" },
  { name: "trend", label: "Trend", hotkey: "2" },
  { name: "breakdown", label: "Breakdown", hotkey: "3" },
  { name: "activity", label: "Activity", hotkey: "4" },
];

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: "Session",
  seven_day: "Week",
  seven_day_opus: "Week Opus",
  seven_day_sonnet: "Week Sonnet",
  spend_limit: "Spend",
};

const LABEL_WIDTH = 10;
const ACCENT = "claude";
const MUTED = "subtle";

export function tray(view: TrayView) {
  const { Box } = view.ui;

  return (
    <Box flexDirection="column" paddingX={1}>
      {header(view)}
      {station(view)}
    </Box>
  );
}

function header({ ui, station, plan, onSelect }: TrayView) {
  const { Box, Text, Button } = ui;

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Text color={ACCENT} bold>
        ✻ Claude
      </Text>
      {plan ? <Text color={ACCENT}>{plan}</Text> : null}
      <Text dimColor>·</Text>
      {STATIONS.map((entry) => (
        <Button
          key={`station-${entry.name}`}
          label={entry.label}
          hotkey={entry.hotkey}
          variant={entry.name === station ? "primary" : "secondary"}
          onPress={() => onSelect(entry.name)}
        />
      ))}
    </Box>
  );
}

function station(view: TrayView) {
  switch (view.station) {
    case "trend":
      return trend(view);
    case "breakdown":
      return breakdown(view);
    case "activity":
      return activityGrid(view);
    default:
      return usage(view);
  }
}

function row(ui: Ui, label: string, ...children: RenderChildren[]) {
  const { Box, Text } = ui;

  return (
    <Box flexDirection="row">
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexDirection="row" flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

function usage({ ui, ledger, live, now, isWorking, columns, cache }: TrayView) {
  const { Box, Text } = ui;
  const day = today(ledger, now);
  const cachePercent = day.inputTokens > 0 ? Math.round((day.cacheReadTokens / day.inputTokens) * 100) : 0;
  const meterWidth = Math.min(Math.max(columns - LABEL_WIDTH - 20, 10), 40);

  const limits = (live?.rateLimits ?? []).map((limit) => {
    const meter = bar(limit.percentUsed, meterWidth);
    const color = limit.percentUsed >= 90 ? "error" : limit.percentUsed >= 75 ? "warning" : ACCENT;
    const resetsIn = limit.resetsAt ? Date.parse(limit.resetsAt) - now : undefined;

    return row(
      ui,
      RATE_LIMIT_LABELS[limit.kind] ?? limit.kind,
      <Text color={color}>{meter.filled}</Text>,
      <Text color={MUTED}>{meter.empty}</Text>,
      <Text bold>{` ${Math.round(limit.percentUsed)}%`.padStart(5)}</Text>,
      resetsIn === undefined || Number.isNaN(resetsIn) ? null : <Text dimColor>{`  ↻ ${countdown(resetsIn)}`}</Text>,
    );
  });

  const todayRow = row(
    ui,
    "Today",
    <Text bold>{money(day.usd)}</Text>,
    <Text dimColor>{` API value · ${short(day.tokens)} tokens · ${cachePercent}% from cache`}</Text>,
  );

  // The running turn's stopwatch, or how long the last turn took once it is done.
  const turnTime =
    live?.turnStartedAt !== undefined ? (
      <Text color={ACCENT} bold>{`  ${elapsed(now - live.turnStartedAt)}`}</Text>
    ) : live?.lastTurnMs !== undefined ? (
      <Text dimColor>{`  last turn ${elapsed(live.lastTurnMs)}`}</Text>
    ) : null;

  const cacheText = cacheLabel(cacheStatus(cache ?? {}, now));

  const nowRow = live
    ? row(
        ui,
        "Now",
        <Text color={isWorking ? ACCENT : MUTED}>● </Text>,
        <Text bold wrap="truncate-end">
          {live.project}
        </Text>,
        <Text dimColor wrap="truncate-end">
          {[
            ` · ${live.model}`,
            ` · ${short(live.outputTokens)} written`,
            ` · ${money(live.usd)}`,
            live.contextPercent === undefined ? "" : ` · context ${Math.round(live.contextPercent)}%`,
          ].join("")}
        </Text>,
        cacheText ? <Text dimColor>{` · ${cacheText}`}</Text> : null,
        turnTime,
      )
    : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {limits}
      {todayRow}
      {nowRow}
    </Box>
  );
}

function trend({ ui, ledger, now, columns }: TrayView) {
  const { Box, Text } = ui;
  const hours = hourly(ledger, now);
  const total = hours.reduce((sum, usd) => sum + usd, 0);
  // Two cells and a gap per hour when there is room, then one and a gap, then one.
  const barWidth = columns >= 75 ? 2 : 1;
  const gap = columns >= 50 ? 1 : 0;
  const rows = verticalBars(hours, 4);
  const currentHour = new Date(now).getHours();
  const step = barWidth + gap;

  const barRows = rows.map((line, rowIndex) => {
    const isBaseline = rowIndex === rows.length - 1;

    return (
      <Box flexDirection="row">
        {[...line].map((glyph, hour) => {
          const isEmptyBaseline = isBaseline && glyph === " " && hour <= currentHour;
          const cell = (isEmptyBaseline ? "▁" : glyph).repeat(barWidth) + " ".repeat(gap);

          return <Text color={isEmptyBaseline ? MUTED : ACCENT}>{cell}</Text>;
        })}
      </Box>
    );
  });

  const axisWidth = 24 * step;
  const axis = "00".padEnd(12 * step) + "12".padEnd(axisWidth - 12 * step - 2) + "23";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" width={axisWidth} justifyContent="space-between">
        <Text bold>Spend by hour</Text>
        <Text dimColor>{`Today · ${money(total)}`}</Text>
      </Box>
      {barRows}
      <Text dimColor>{axis}</Text>
    </Box>
  );
}

function breakdown({ ui, ledger, now, columns }: TrayView) {
  const { Box, Text } = ui;
  const day = today(ledger, now);
  const isSideBySide = columns >= 90;
  const listWidth = isSideBySide ? Math.floor((columns - 2) / 2) : columns;

  const list = (title: string, record: Record<string, number>) => {
    const entries = ranked(record, 5);
    const top = entries[0]?.usd ?? 0;
    const meterWidth = Math.min(16, Math.max(6, listWidth - 34));

    return (
      <Box flexDirection="column" width={listWidth}>
        <Text bold>{title}</Text>
        {entries.length === 0 ? <Text dimColor>Nothing cooked yet today</Text> : null}
        {entries.map((entry) => {
          const meter = bar(top > 0 ? (entry.usd / top) * 100 : 0, meterWidth);

          return (
            <Box flexDirection="row" columnGap={1}>
              <Box width={20} flexShrink={1}>
                <Text wrap="truncate-middle">{entry.name}</Text>
              </Box>
              <Text color={ACCENT}>{meter.filled}</Text>
              <Text>{meter.empty.replaceAll("░", " ")}</Text>
              <Text dimColor>{money(entry.usd).padStart(8)}</Text>
            </Box>
          );
        })}
      </Box>
    );
  };

  return (
    <Box flexDirection={isSideBySide ? "row" : "column"} columnGap={2} rowGap={1} marginTop={1}>
      {list("Models", day.models)}
      {list("Projects", day.projects)}
    </Box>
  );
}

const SHADES = ["░░", "▒▒", "▓▓", "██"];
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];

function activityGrid({ ui, ledger, now, columns, backfillStatus }: TrayView) {
  const { Box, Text } = ui;
  const grid = activity(ledger, now);
  const top = Math.max(...grid.weeks.flat().map((tokens) => tokens ?? 0), 0);

  const cell = (tokens: number | null) => {
    if (tokens === null) {
      return <Text>{"  "}</Text>;
    }

    if (tokens === 0 || top === 0) {
      return <Text color={MUTED}>{"· "}</Text>;
    }

    const level = Math.min(SHADES.length - 1, Math.ceil((tokens / top) * SHADES.length) - 1);
    return <Text color={ACCENT}>{SHADES[level]}</Text>;
  };

  const rows = WEEKDAYS.map((weekday, dayIndex) => (
    <Box flexDirection="row">
      <Box width={4}>
        <Text dimColor>{weekday}</Text>
      </Box>
      {grid.weeks.map((week) => cell(week[dayIndex] ?? null))}
    </Box>
  ));

  const busiest = grid.busiest
    ? `${new Date(`${grid.busiest.key}T12:00:00`).toLocaleDateString("en-US", { day: "2-digit", month: "short" })} · ${short(grid.busiest.tokens)}`
    : "—";

  const stats = (
    <Box flexDirection="column" marginLeft={columns >= 60 ? 3 : 0}>
      <Text bold>{`${short(grid.totalTokens)} tokens`}</Text>
      <Text dimColor>{`${grid.weeks.length} weeks`}</Text>
      <Text> </Text>
      <Text>
        <Text dimColor>Active days </Text>
        {String(grid.activeDays)}
      </Text>
      <Text>
        <Text dimColor>Busiest day </Text>
        {busiest}
      </Text>
      <Text>
        <Text dimColor>Streak </Text>
        <Text color={ACCENT}>{`${grid.streak} ${grid.streak === 1 ? "day" : "days"}`}</Text>
        {today(ledger, now).tokens > 0 ? "" : " (cook today to keep it)"}
      </Text>
    </Box>
  );

  const history = backfillStatus?.isRunning
    ? "Reading your Claude Code history…"
    : ledger.backfill
      ? `History from ${ledger.backfill.files} transcripts, estimated at list prices. /chef backfill rescans it.`
      : "Only turns since the tray was installed. /chef backfill reads your earlier history.";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection={columns >= 60 ? "row" : "column"}>
        <Box flexDirection="column">{rows}</Box>
        {stats}
      </Box>
      <Text dimColor wrap="wrap">
        {history}
      </Text>
    </Box>
  );
}
