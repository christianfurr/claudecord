import { test, expect } from "bun:test";
import { activityLine, tablesToCodeBlocks } from "./format.js";

test("tablesToCodeBlocks wraps a markdown table in a code fence with aligned columns", () => {
  const md = ["| Name | Age |", "| --- | --- |", "| Bob | 30 |", "| Alexander | 7 |"].join("\n");
  const out = tablesToCodeBlocks(md);
  expect(out.startsWith("```\n")).toBe(true);
  expect(out.endsWith("\n```")).toBe(true);
  expect(out).toContain("Name       Age"); // header padded to widest cell "Alexander"
  expect(out).toContain("Bob        30");
  expect(out).not.toContain("|");
});

test("tablesToCodeBlocks honors right and center alignment from the delimiter row", () => {
  const md = ["| left | right | c |", "| :-- | --: | :-: |", "| a | b | mid |"].join("\n");
  const out = tablesToCodeBlocks(md);
  expect(out).toContain("a         b  mid"); // "a" left, "b" pushed right in its column, centered "mid"
  expect(out).toContain("left  right   c"); // header row respects the same alignment
});

test("tablesToCodeBlocks leaves prose and lone pipes untouched", () => {
  const text = "Here is a pipe | in a sentence.\nNo table here.";
  expect(tablesToCodeBlocks(text)).toBe(text);
});

test("tablesToCodeBlocks preserves surrounding text around a table", () => {
  const md = ["Before.", "| A | B |", "| - | - |", "| 1 | 2 |", "After."].join("\n");
  const out = tablesToCodeBlocks(md);
  expect(out.startsWith("Before.\n```")).toBe(true);
  expect(out.endsWith("```\nAfter.")).toBe(true);
});

test("activityLine renders send_file with a friendly label and the basename", () => {
  const line = activityLine("mcp__discord__send_file", { path: "/Users/x/Desktop/COURT/citation.pdf" });
  expect(line).toContain("send_file");
  expect(line).toContain("citation.pdf");
  expect(line).not.toContain("mcp__discord__");
});

test("activityLine falls back to the raw tool name when there is no detail", () => {
  expect(activityLine("Bash", { command: "npm test" })).toContain("Bash");
  expect(activityLine("SomethingElse", {})).toBe("⏺ **SomethingElse**");
});
