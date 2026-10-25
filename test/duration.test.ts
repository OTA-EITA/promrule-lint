import { describe, expect, it } from "vitest";
import { formatDuration, parseDuration } from "../src/duration.js";

describe("parseDuration", () => {
  it.each([
    ["0", 0],
    ["30s", 30_000],
    ["5m", 300_000],
    ["1h30m", 5_400_000],
    ["2w", 1_209_600_000],
    ["500ms", 500],
    ["1y", 31_536_000_000],
  ])("%s", (s, ms) => {
    expect(parseDuration(s)).toBe(ms);
  });

  it.each(["", "5", "m", "5x", "30m1h", "1m1m", "1m ", " 1m", "-1m"])("rejects %j", (s) => {
    expect(parseDuration(s)).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it.each([
    [30_000, "30s"],
    [120_000, "2m"],
    [5_400_000, "90m"],
    [1500, "1500ms"],
  ])("%i", (ms, s) => {
    expect(formatDuration(ms)).toBe(s);
  });
});
