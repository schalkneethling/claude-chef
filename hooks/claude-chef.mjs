const HISTORY = 12;
const BARS = "▁▂▃▄▅▆▇█";
const FORECAST = [
  { upTo: 25, icon: "☀", word: "Clear", color: "yellow" },
  { upTo: 50, icon: "☁", word: "Cloudy", color: "cyan" },
  { upTo: 75, icon: "☂", word: "Showers", color: "blue" },
  { upTo: 90, icon: "☇", word: "Storm", color: "magenta" },
  { upTo: Infinity, icon: "↯", word: "Compact soon", color: "red" },
];

// Held by the host, so the history survives a hot reload of this file.
const readings = {
  plugin: "claude-chef",
  key: "readings",
};

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await takeReading($);
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) {
      await takeReading($); // main-loop turns only, not subagents
    }
    return result;
  });

  on("ui.render", {component: "AbovePrompt"}, async ($, e, next) => {
    const { value: history = [] } = await $.state.get(readings);

    if (e.props.hasSurvey || history.length === 0) {
      return next(e);
    }

    const { Box, Text } = $.ui.resolve(e);
    return band(Box, Text, history, e.props.bodyColumns);
  });
}

async function takeReading($) {
  const { context } = await $.session.usage();

  if (!context?.window) {
    return;
  }

  const tokens = context.tokens ?? 0;
  const percent = context.percent ?? Math.round((tokens / context.window) * 100);
  const { value: history = [] } = await $.state.get(readings);

  await $.state.set(readings, [...history, { tokens, window: context.window, percent }].slice(-HISTORY));
}

function band(Box, Text, history, bodyColumns) {
  const now = history[history.length - 1];
  const f = FORECAST.find((currentEntry) => now.percent < currentEntry.upTo);
  const parts = [
    Text({ color: f.color, bold: true, children: `${f.icon} ${f.word}` }),
    Text({ children: `  ${now.percent}% of context` }),
    Text({ dimColor: true, children: `  ${short(now.tokens)} / ${short(now.window)}` }),
  ];

  if (bodyColumns >= 60) {
    parts.push(Text({ dimColor: true, children: "   last turn " }));
    parts.push(Text({ color: f.color, children: sparkline(history) }));

    if (history.length > 1) {
      parts.push(Text({ dimColor: true, children: trend(history) }));
    }
  }

  return Box({ flexDirection: "row", paddingX: 1, paddingY: 1, children: parts });
}

function sparkline(history) {
  const top = Math.max(...history.map((r) => r.tokens), 1);
  return history.map((r) => BARS[Math.floor((r.tokens / top) * (BARS.length - 1))]).join("");
}

function trend(history) {
  const delta = history[history.length - 1].tokens - history[history.length - 2].tokens;

  if (delta === 0) {
    return "  steady";
  }

  return delta > 0 ? `  ▲ +${short(delta)} last turn` : `  ▼ ${short(-delta)} last turn`;
}

function short(n) {
  if (n >= 1_000_000) {
    return `${+(n / 1_000_000).toFixed(1)}M`;
  }

  if (n >= 1_000) {
    return `${+(n / 1_000).toFixed(1)}k`;
  }

  return String(n);
}
