const EIGHTHS = " ▁▂▃▄▅▆▇█";

export function short(n: number): string {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];

  for (const [size, suffix] of units) {
    if (n >= size) {
      return `${+(n / size).toFixed(1)}${suffix}`;
    }
  }

  return String(Math.round(n));
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * A model id as people say it: `claude-opus-5-5` is "Opus 5.5",
 * `claude-3-5-sonnet-20241022` is "Sonnet 3.5". A context-window suffix such
 * as `[1m]`, which `/model` shows, is dropped. Anything else is kept as given.
 */
export function modelName(model: string): string {
  const id = model.replace(/\[[^\]]*\]$/, "");
  const familyFirst = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);

  if (familyFirst) {
    const [, family = "", major = "", minor] = familyFirst;
    return `${capitalize(family)} ${minor ? `${major}.${minor}` : major}`;
  }

  const versionFirst = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/.exec(id);

  if (versionFirst) {
    const [, major = "", minor, family = ""] = versionFirst;
    return `${capitalize(family)} ${minor ? `${major}.${minor}` : major}`;
  }

  return model;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Time until a reset: "1d 23h", "2h 10m", "9m". */
export function countdown(ms: number): string {
  if (ms <= 0) {
    return "now";
  }

  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }

  return `${minutes}m`;
}

/** A stopwatch reading: "0:33", "12:05", and past an hour "1:02:03". */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const pad = (value: number) => String(value).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
  }

  return `${minutes}:${pad(seconds % 60)}`;
}

/** A horizontal meter `width` cells wide, split so each part can take its own color. */
export function bar(percent: number, width: number): { filled: string; empty: string } {
  const cells = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * width);
  return { filled: "█".repeat(cells), empty: "░".repeat(width - cells) };
}

/**
 * Columns of eighth blocks, `rows` tall, one character per value, returned top
 * row first. The largest value fills the height; any value above zero shows
 * at least one eighth so a quiet hour is still visible.
 */
export function verticalBars(values: number[], rows: number): string[] {
  const top = Math.max(...values, 0);
  const levels = rows * 8;
  const heights = values.map((value) => {
    if (value <= 0 || top === 0) {
      return 0;
    }

    return Math.max(1, Math.round((value / top) * levels));
  });

  return Array.from({ length: rows }, (_, rowFromTop) => {
    const floor = (rows - 1 - rowFromTop) * 8;
    return heights.map((height) => EIGHTHS[Math.min(Math.max(height - floor, 0), 8)]).join("");
  });
}
