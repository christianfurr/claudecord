import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { Table } from "./format.js";

// Discord dark-mode palette, so the image sits naturally in the channel.
const COLORS = {
  bg: "#1e1f22",
  headerBg: "#2b2d31",
  rowAlt: "#232428",
  text: "#dbdee1",
  headerText: "#f2f3f5",
  border: "#3f4147",
  accent: "#5865f2",
};

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
const FONT_SIZE = 15;
const CHAR_PX = 8.4; // rough advance width for Inter at 15px
const CELL_PAD_X = 14;
const CELL_PAD_Y = 9;
const MIN_COL = 44;
const MAX_COL = 320;

let fontsCache: Array<{ name: string; data: Buffer; weight: 400 | 600; style: "normal" }> | undefined;

function fonts() {
  if (!fontsCache) {
    fontsCache = [
      { name: "Inter", data: readFileSync(join(FONT_DIR, "Inter-Regular.woff")), weight: 400, style: "normal" },
      { name: "Inter", data: readFileSync(join(FONT_DIR, "Inter-SemiBold.woff")), weight: 600, style: "normal" },
    ];
  }
  return fontsCache;
}

// The bundled Inter subset covers ASCII only, and resvg color-emoji support is
// unreliable — so map the status emoji we actually emit to plain text and strip
// any other emoji/symbols before rendering, leaving no tofu boxes. (The code-block
// fallback path keeps the real emoji, which Discord renders natively.)
const EMOJI_TEXT: Record<string, string> = {
  "✅": "yes",
  "✔": "yes",
  "☑": "yes",
  "❌": "no",
  "✖": "no",
  "⚠": "!",
  "🟢": "live",
  "🔴": "off",
  "🟡": "busy",
  "💤": "idle",
  "⚙": "working",
  "🚧": "wip",
  "⏺": "•",
  "💭": "",
  "📊": "",
};

const STRIP_EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}️‍]/gu;

function sanitizeCell(text: string): string {
  let s = text;
  for (const [emoji, word] of Object.entries(EMOJI_TEXT)) s = s.split(emoji).join(word);
  return s.replace(STRIP_EMOJI, "").replace(/[ \t]{2,}/g, " ").trim();
}

/** A satori-compatible vnode (React-element shape) built without JSX. */
type VNode = { type: string; props: { style: Record<string, unknown>; children?: unknown } };

function cell(text: string, colPx: number, align: string, header: boolean, last: boolean): VNode {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        width: `${colPx}px`,
        padding: `${CELL_PAD_Y}px ${CELL_PAD_X}px`,
        justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start",
        textAlign: align,
        borderRight: last ? "none" : `1px solid ${COLORS.border}`,
        color: header ? COLORS.headerText : COLORS.text,
        fontWeight: header ? 600 : 400,
        // satori has no word-break; allow wrapping so long cells grow the row.
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        lineHeight: 1.35,
      },
      children: text,
    },
  };
}

function row(cells: VNode[], background: string, bottomBorder: boolean): VNode {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "row",
        background,
        borderBottom: bottomBorder ? `1px solid ${COLORS.border}` : "none",
      },
      children: cells,
    },
  };
}

/** Estimate each column's pixel width from its widest cell, clamped. */
function columnWidths(rows: string[][], cols: number): number[] {
  return Array.from({ length: cols }, (_, c) => {
    const widestLine = Math.max(
      ...rows.map((r) => Math.max(...(r[c] ?? "").split("\n").map((line) => line.length))),
    );
    const raw = widestLine * CHAR_PX + CELL_PAD_X * 2;
    return Math.round(Math.min(MAX_COL, Math.max(MIN_COL, raw)));
  });
}

/** Render a parsed table to a PNG buffer (2× for crisp display on mobile). */
export async function renderTablePng(table: Table): Promise<Buffer> {
  const { aligns } = table;
  const rows = table.rows.map((r) => r.map(sanitizeCell));
  const cols = Math.max(...rows.map((r) => r.length));
  const colPx = columnWidths(rows, cols);
  const width = colPx.reduce((a, b) => a + b, 0) + 2; // + container border

  const vnodes: VNode[] = rows.map((r, ri) => {
    const isHeader = ri === 0;
    const cells = Array.from({ length: cols }, (_, c) =>
      cell(r[c] ?? "", colPx[c], aligns[c] ?? "left", isHeader, c === cols - 1),
    );
    const bg = isHeader ? COLORS.headerBg : ri % 2 === 0 ? COLORS.rowAlt : COLORS.bg;
    return row(cells, bg, ri < rows.length - 1);
  });

  const container: VNode = {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        width: `${width}px`,
        border: `1px solid ${COLORS.border}`,
        borderTop: `3px solid ${COLORS.accent}`,
        borderRadius: "8px",
        overflow: "hidden",
        fontFamily: "Inter",
        fontSize: `${FONT_SIZE}px`,
        background: COLORS.bg,
      },
      children: vnodes,
    },
  };

  const svg = await satori(container as unknown as Parameters<typeof satori>[0], {
    width,
    fonts: fonts(),
  });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width * 2 } }).render().asPng();
  return Buffer.from(png);
}
