import type { ChefStationContextCategory } from "../types";

/**
 * Eight categorical colors, one per slot, in a fixed order. They are the
 * dark-surface steps of the data-visualization reference palette, which pass
 * every check on a light surface (#fcfcfb) and a dark surface (#1a1a19) alike:
 * the lightness band, the chroma floor, protanopia and deuteranopia separation
 * between neighbors (worst 8.4 against a target of 8), the normal-vision floor
 * (worst 19.3 against 15) and contrast. The yellow sits at 2.99:1 on the light
 * surface, which is why the legend always names each category beside its color.
 *
 * Only neighboring slots are validated as a pair: with all eight in play, some
 * slots that are not neighbors (aqua and magenta under deuteranopia, red and
 * orange for everyone) cannot be told apart. So the bar hands the slots out
 * in its own order, and two segments that touch are always neighboring slots.
 * The order is part of what makes neighbors distinguishable; never reorder it.
 */
export const CONTEXT_PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/** A neutral gray for the categories folded into "Other": not a hue, so it claims no identity. */
const OTHER_COLOR = "#8a8986";

export type ContextSegment = {
  name: string;
  tokens: number;
  kind: "used" | "free" | "buffer";
  /** A palette color for a category, or a theme key for free space and the buffer. */
  color: string;
  /** The character the segment is drawn with, so free space and the buffer differ by texture as well. */
  glyph: string;
};

/**
 * The breakdown as the bar draws it, left to right: what fills the window, in
 * the order /context lists it, then the free space, then the compaction
 * buffer. Schemas loaded on demand sit outside the window and are left out.
 * Each filled category takes the next palette slot in bar order; past the
 * eighth, the rest fold into "Other" rather than reuse a color.
 */
export function contextSegments(categories: readonly ChefStationContextCategory[]): ContextSegment[] {
  const used = categories.filter((category) => category.kind === "used" && category.tokens > 0);
  const segments: ContextSegment[] = [];
  let otherTokens = 0;

  for (const [slot, category] of used.entries()) {
    const color = CONTEXT_PALETTE[slot];

    if (color === undefined) {
      otherTokens += category.tokens;
      continue;
    }

    segments.push({ name: category.name, tokens: category.tokens, kind: "used", color, glyph: "█" });
  }

  if (otherTokens > 0) {
    segments.push({ name: "Other", tokens: otherTokens, kind: "used", color: OTHER_COLOR, glyph: "█" });
  }

  for (const category of categories) {
    if (category.kind === "free" && category.tokens > 0) {
      segments.push({ name: category.name, tokens: category.tokens, kind: "free", color: "subtle", glyph: "░" });
    }
  }

  for (const category of categories) {
    if (category.kind === "buffer" && category.tokens > 0) {
      segments.push({ name: category.name, tokens: category.tokens, kind: "buffer", color: "subtle", glyph: "▒" });
    }
  }

  return segments;
}

/**
 * Shares `width` cells among `values` in proportion, adding up to exactly
 * `width`. Any value above zero gets at least one cell, so every category the
 * legend names is visible in the bar; those cells come from the largest share.
 */
export function allocateCells(values: readonly number[], width: number): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);

  if (total <= 0 || width <= 0) {
    return values.map(() => 0);
  }

  const exact = values.map((value) => (value / total) * width);
  const cells = exact.map((share, index) => (values[index]! > 0 ? Math.max(1, Math.floor(share)) : 0));
  let assigned = cells.reduce((sum, count) => sum + count, 0);

  // Hand the cells rounding left over to the largest fractional parts, earliest first on a tie.
  const byRemainder = exact
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .filter(({ index }) => values[index]! > 0)
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let next = 0; assigned < width && byRemainder.length > 0; next = (next + 1) % byRemainder.length) {
    cells[byRemainder[next]!.index]! += 1;
    assigned += 1;
  }

  // The one-cell minimums can overshoot; take the excess from the largest share.
  while (assigned > width) {
    const largest = cells.indexOf(Math.max(...cells));

    if (cells[largest]! <= 1) {
      break;
    }

    cells[largest]! -= 1;
    assigned -= 1;
  }

  return cells;
}
