import { test, expect } from "bun:test";
import { activityLine } from "./format.js";

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
