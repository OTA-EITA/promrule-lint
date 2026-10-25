import { describe, expect, it } from "vitest";
import { aggregatedInput, calls, maskStrings, rangeWindows } from "../src/promql.js";

describe("maskStrings", () => {
  it("blanks string contents but keeps offsets", () => {
    const e = "x{path=\"/a[1]\", q='('} and y{p=`)`}";
    const m = maskStrings(e);
    expect(m).toHaveLength(e.length);
    expect(m).not.toMatch(/\[1\]|\(|\)/);
  });

  it("handles escaped quotes", () => {
    expect(maskStrings('x{a="b\\"[c]"}')).toBe('x{a="      "}');
  });
});

describe("calls", () => {
  it("finds nested calls with their arguments, skipping keywords", () => {
    const c = calls(
      'sum by (job) (rate(http_requests_total{code="5.."}[5m])) / on (job) group_left count(up)',
    );
    expect(c.map((x) => x.name)).toEqual(["sum", "rate", "count"]);
    expect(c[1]?.args).toBe('http_requests_total{code="   "}[5m]');
  });

  it("tolerates unbalanced parentheses", () => {
    expect(calls("rate(x[5m]")).toEqual([{ name: "rate", args: "x[5m]" }]);
  });
});

describe("rangeWindows", () => {
  it("returns ranges and subquery ranges at the top level only", () => {
    expect(rangeWindows("x[5m]")).toEqual(["5m"]);
    expect(rangeWindows("sum(x)[30m:1m]")).toEqual(["30m"]);
    expect(rangeWindows("max_over_time(rate(x[1m])[1h:])")).toEqual([]);
    expect(rangeWindows("x[ 2m ]")).toEqual(["2m"]);
  });
});

describe("aggregatedInput", () => {
  it.each([
    ["sum(x)[5m:]", "sum"],
    ["  max by (job) (x)[5m:]", "max"],
    ["count without(instance)(x)[5m:]", "count"],
    ["x[5m]", undefined],
    ["summary_total[5m]", undefined],
  ])("%s", (args, want) => {
    expect(aggregatedInput(args)).toBe(want);
  });
});
