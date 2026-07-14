import { test, expect } from "bun:test";
import { splitSegments, type Table } from "./format.js";
import { renderTablePng } from "./render-table.js";

function tableFrom(md: string): Table {
  const seg = splitSegments(md).find((s) => s.type === "table");
  if (!seg || seg.type !== "table") throw new Error("no table parsed");
  return seg;
}

test("renderTablePng produces a valid PNG", async () => {
  const png = await renderTablePng(
    tableFrom(["| Item | State |", "| --- | :---: |", "| Converter | done |"].join("\n")),
  );
  expect(png.length).toBeGreaterThan(1000);
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG"); // 0x89 P N G
});

test("renderTablePng renders emoji cells without throwing (sanitized to text)", async () => {
  const png = await renderTablePng(
    tableFrom(["| Task | Done |", "| --- | :---: |", "| Ship | ✅ |", "| Sleep | ❌ |"].join("\n")),
  );
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
});

test("renderTablePng handles ragged rows (fewer cells than the header)", async () => {
  const png = await renderTablePng(
    tableFrom(["| A | B | C |", "| - | - | - |", "| just one |"].join("\n")),
  );
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
});
