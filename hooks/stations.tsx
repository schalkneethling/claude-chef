import type { Elements, RenderChildren } from "claude-code";

import type {
  ChefStationAgent,
  ChefStationAgents,
  ChefStationCache,
  ChefStationContext,
  ChefStationContextAction,
  ChefStationLedger,
  ChefStationLive,
  ChefStationName,
} from "../types";
import { partitionAgents, SURFACE_LABELS } from "./agents";
import { cacheLabel, cacheStatus } from "./cache";
import { allocateCells, contextSegments } from "./context";
import { ago, bar, countdown, elapsed, money, short, verticalBars } from "./format";
import { activity, hourly, ranked, today } from "./ledger";

/** The elements a station draws with; the terminal's and the desktop's tables both have them. */
export type Ui = Pick<Elements["terminal"], "Box" | "Text" | "Button">;

export type SidebarView = {
  ui: Ui;
  /** The stations whose sections are open, each drawing its body under its header. */
  openSections: readonly ChefStationName[];
  ledger: ChefStationLedger;
  live?: ChefStationLive;
  now: number;
  plan?: string;
  /** Whether a scan of the transcripts is running, and what the last one said. */
  backfillStatus?: { isRunning: boolean; message?: string };
  /** The main conversation's prompt cache: when it was last used, and how long its entries live. */
  cache?: ChefStationCache;
  /** The context window by category; null until the first measurement. */
  context?: ChefStationContext | null;
  /** Whether Clear or Compact is running, whether Clear awaits confirmation, and what the last one said. */
  contextAction?: ChefStationContextAction;
  onContextAction?: (action: "compact" | "clear" | "confirm-clear" | "cancel-clear") => void;
  /** Every live Claude Code session on this machine, for the Agents station. */
  agents?: ChefStationAgents;
  /** Whether the Agents station lists its idle sessions or keeps them folded under one row. */
  isIdleOpen: boolean;
  isWorking: boolean;
  columns: number;
  onToggle: (station: ChefStationName) => void;
  onToggleIdle: () => void;
};

export const STATIONS: { name: ChefStationName; label: string; hotkey: string }[] = [
  { name: "usage", label: "Usage", hotkey: "1" },
  { name: "trend", label: "Trend", hotkey: "2" },
  { name: "breakdown", label: "Breakdown", hotkey: "3" },
  { name: "activity", label: "Activity", hotkey: "4" },
  { name: "context", label: "Context", hotkey: "5" },
  { name: "agents", label: "Agents", hotkey: "6" },
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
/** What a section's frame takes from the width: its border and its padding, a cell each side. */
const SECTION_FRAME_COLUMNS = 4;

export function sidebar(view: SidebarView) {
  const { Box, Text } = view.ui;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" columnGap={1}>
        <Text color={ACCENT} bold>
          ✻ Claude
        </Text>
        {view.plan ? <Text color={ACCENT}>{view.plan}</Text> : null}
      </Box>
      {STATIONS.map((entry) => section(view, entry))}
    </Box>
  );
}

/**
 * One station as a section that opens and closes like a disclosure: a header
 * that toggles it, with a one-line summary beside it so a closed section
 * still says something, and the station's body below while it is open.
 */
function section(view: SidebarView, entry: (typeof STATIONS)[number]) {
  const { Box, Text, Button } = view.ui;
  const isOpen = view.openSections.includes(entry.name);
  const summary = summaryOf(entry.name, view);
  // The body draws inside the frame, so it is told the width it really has.
  const body = { ...view, columns: Math.max(10, view.columns - SECTION_FRAME_COLUMNS) };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1} marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Button key={`section-${entry.name}`} plain hotkey={entry.hotkey} onPress={() => view.onToggle(entry.name)}>
          {`${isOpen ? "▾" : "▸"} ${entry.label}`}
        </Button>
        {summary ? (
          <Text dimColor wrap="truncate-end">
            {summary}
          </Text>
        ) : null}
      </Box>
      {isOpen ? station(entry.name, body) : null}
    </Box>
  );
}

/** The line beside a section's header: the one figure worth seeing while the section is closed. */
function summaryOf(name: ChefStationName, { ledger, live, now, context, agents }: SidebarView): string | undefined {
  switch (name) {
    case "usage": {
      const spent = `${money(today(ledger, now).usd)} today`;
      const tightest = [...(live?.rateLimits ?? [])].sort((a, b) => b.percentUsed - a.percentUsed)[0];
      return tightest ? `${spent} · ${RATE_LIMIT_LABELS[tightest.kind] ?? tightest.kind} ${Math.round(tightest.percentUsed)}%` : spent;
    }
    case "trend":
      return `${money(hourly(ledger, now)[new Date(now).getHours()] ?? 0)} this hour`;
    case "breakdown": {
      const top = ranked(today(ledger, now).models, 1)[0];
      return top ? `${top.name} ${money(top.usd)}` : undefined;
    }
    case "activity": {
      const { streak, activeDays } = activity(ledger, now);
      return streak > 0 ? `${streak}-day streak` : `${activeDays} active days`;
    }
    case "context": {
      const percent = context && context.maxTokens > 0 ? (context.totalTokens / context.maxTokens) * 100 : live?.contextPercent;
      return percent === undefined ? undefined : `${Math.round(percent)}% used`;
    }
    case "agents": {
      if (!agents || agents.refreshedAt === 0) {
        return undefined;
      }

      const { active } = partitionAgents(agents.agents, now);
      const waiting = agents.agents.filter((agent) => agent.status === "waiting").length;
      return `${waiting > 0 ? `${waiting} waiting · ` : ""}${active.length} active of ${agents.agents.length}`;
    }
  }
}

/** The body of one station's section. */
function station(name: ChefStationName, view: SidebarView) {
  switch (name) {
    case "trend":
      return trend(view);
    case "breakdown":
      return breakdown(view);
    case "activity":
      return activityGrid(view);
    case "context":
      return contextWindow(view);
    case "agents":
      return agentsList(view);
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

/**
 * The Usage station: the plan's rate-limit windows, today's spend, and the
 * Now row for this session, its prompt cache countdown included.
 */
function usage({ ui, ledger, live, now, isWorking, columns, cache }: SidebarView) {
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

function trend({ ui, ledger, now, columns }: SidebarView) {
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

function breakdown({ ui, ledger, now, columns }: SidebarView) {
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

function activityGrid({ ui, ledger, now, columns, backfillStatus }: SidebarView) {
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
      : "Only turns since Chef Station was installed. /chef backfill reads your earlier history.";

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

/** Each legend entry's width, so entries line up in columns as they wrap. */
const LEGEND_ENTRY_WIDTH = 36;

/**
 * The Context station: the window as one bar of categories, a legend that
 * names each color with its tokens and share, and the Compact and Clear buttons.
 */
function contextWindow({ ui, context, columns, isWorking, contextAction, onContextAction }: SidebarView) {
  const { Box, Text } = ui;

  if (!context) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Measuring the context window…</Text>
      </Box>
    );
  }

  const segments = contextSegments(context.categories);
  // A one-cell gap separates segments, so a boundary shows without relying on color.
  const gaps = Math.max(0, segments.length - 1);
  const cells = allocateCells(
    segments.map((segment) => segment.tokens),
    Math.max(10, columns - 2 - gaps),
  );
  const share = (tokens: number) => {
    const percent = (tokens / context.maxTokens) * 100;
    return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
  };

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" columnGap={1}>
        <Text bold>Context window</Text>
        <Text dimColor>{`${short(context.totalTokens)} of ${short(context.maxTokens)} tokens (${share(context.totalTokens)})`}</Text>
      </Box>
      <Box flexDirection="row">
        {segments.map((segment, index) => (
          <Text color={segment.color}>{(index > 0 ? " " : "") + segment.glyph.repeat(cells[index] ?? 0)}</Text>
        ))}
      </Box>
      {/* Identity is never color alone: every color in the bar is named here, in the text color. */}
      <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
        {segments.map((segment) => (
          <Box flexDirection="row" width={LEGEND_ENTRY_WIDTH} columnGap={1}>
            <Text color={segment.color}>{segment.glyph.repeat(2)}</Text>
            <Box width={20} flexShrink={1}>
              <Text wrap="truncate-end">{segment.name}</Text>
            </Box>
            <Text dimColor>{`${short(segment.tokens)} · ${share(segment.tokens)}`}</Text>
          </Box>
        ))}
      </Box>
      {contextActions(ui, isWorking, contextAction, onContextAction)}
    </Box>
  );
}

/**
 * Compact and Clear. Neither can run during a turn (compacting is refused,
 * and a /clear would wait for the turn to end), so while Claude works the
 * buttons give way to a note. Clear ends the conversation, so it asks first.
 */
function contextActions(
  ui: Ui,
  isWorking: boolean,
  action: ChefStationContextAction | undefined,
  onAction: SidebarView["onContextAction"],
) {
  const { Box, Text, Button } = ui;
  const message = action?.message ? <Text dimColor>{action.message}</Text> : null;

  if (action?.isRunning) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Working on it…</Text>
      </Box>
    );
  }

  if (isWorking) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Clear and Compact are available once Claude finishes.</Text>
        {message}
      </Box>
    );
  }

  if (action?.isConfirmingClear) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>Clear the conversation? It ends here and a new one starts with an empty context.</Text>
        <Box flexDirection="row" columnGap={1}>
          <Button key="context-clear-confirm" label="Clear conversation" hotkey="y" variant="primary" onPress={() => onAction?.("confirm-clear")} />
          <Button key="context-clear-cancel" label="Cancel" hotkey="n" onPress={() => onAction?.("cancel-clear")} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" columnGap={1}>
        <Button key="context-compact" label="Compact" hotkey="c" onPress={() => onAction?.("compact")} />
        <Button key="context-clear" label="Clear" hotkey="x" onPress={() => onAction?.("clear")} />
      </Box>
      {message}
    </Box>
  );
}

/**
 * The Agents station: every live Claude Code session on this machine, busy
 * ones first, with what each is doing and what it was last asked.
 */
function agentsList({ ui, agents, now, isIdleOpen, onToggleIdle }: SidebarView) {
  const { Box, Text, Button } = ui;

  if (!agents || (agents.refreshedAt === 0 && !agents.error)) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Looking for sessions…</Text>
      </Box>
    );
  }

  const { active, idle } = partitionAgents(agents.agents, now);

  return (
    <Box flexDirection="column" marginTop={1} gap={1}>
      {/* Before the first refresh that worked there is no list to describe, only the error. */}
      {agents.refreshedAt === 0 ? null : <Text dimColor>{`Updated ${ago(now - agents.refreshedAt)}`}</Text>}
      {agents.error ? <Text color="error">{`Could not refresh: ${agents.error}`}</Text> : null}
      {agents.refreshedAt !== 0 && active.length === 0 ? <Text dimColor>No session is busy or has been active in the last 15 minutes.</Text> : null}
      {active.map((agent) => agentCard(ui, agent, now))}
      {idle.length > 0 ? (
        <Box flexDirection="column">
          <Button key="agents-idle" plain onPress={onToggleIdle}>
            {`${isIdleOpen ? "▾" : "▸"} ${idle.length} idle ${idle.length === 1 ? "session" : "sessions"}`}
          </Button>
          {isIdleOpen ? idle.map((agent) => idleRow(ui, agent, now)) : null}
        </Box>
      ) : null}
    </Box>
  );
}

const STATUS_LABELS: Record<ChefStationAgent["status"], string> = {
  waiting: "Waiting",
  busy: "Busy",
  idle: "Idle",
  unknown: "Status unknown",
};

const STATUS_COLORS: Record<ChefStationAgent["status"], string> = {
  waiting: "warning",
  busy: ACCENT,
  idle: "text",
  unknown: "text",
};

/** An active session in full: name, where it runs, what it is doing and what it was last asked. */
function agentCard(ui: Ui, agent: ChefStationAgent, now: number) {
  const { Box, Text } = ui;
  const isBusy = agent.status === "busy";
  const isUnderway = isBusy || agent.status === "waiting";
  const activity = agent.lastActivityAt === undefined ? "" : ` · ${ago(now - agent.lastActivityAt)}`;

  return (
    <Box key={agent.sessionId} flexDirection="column">
      <Text bold color={STATUS_COLORS[agent.status]} wrap="truncate-end">
        {`${isUnderway ? "●" : "○"} ${agent.name}`}
      </Text>
      <Text dimColor wrap="truncate-end">
        {`${STATUS_LABELS[agent.status]} · ${SURFACE_LABELS[agent.surface]} · ${agent.project} · pid ${agent.pid}`}
      </Text>
      {agent.title ? <Text wrap="truncate-end">{`Topic: ${agent.title}`}</Text> : null}
      {agent.lastAction ? (
        <Text wrap="truncate-end">{`${isBusy ? "Now" : "Last step"}: ${agent.lastAction.text}${activity}`}</Text>
      ) : null}
      {agent.lastPrompt ? (
        <Text dimColor wrap="truncate-end">
          {`Last asked: “${agent.lastPrompt}”`}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * An idle session on one line, so a long list of them stays short. A session
 * whose status could not be read folds here too, and its line says so.
 */
function idleRow(ui: Ui, agent: ChefStationAgent, now: number) {
  const { Text } = ui;
  const activity = agent.lastActivityAt === undefined ? "" : ` · ${ago(now - agent.lastActivityAt)}`;
  const status = agent.status === "unknown" ? " · status unknown" : "";

  return (
    <Text key={agent.sessionId} dimColor wrap="truncate-end">
      {`○ ${agent.name} · ${SURFACE_LABELS[agent.surface]} · ${agent.project}${activity}${status}`}
    </Text>
  );
}
