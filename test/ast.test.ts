import { describe, expect, it } from "vitest";
import { parsePromQL, unquote } from "../src/ast.js";

describe("unquote", () => {
  it.each([
    ['"a\\"b"', 'a"b'],
    ["'it\\'s'", "it's"],
    ["`raw\\n`", "raw\\n"],
    ['"\\x41\\u00e9\\101\\n\\q"', "Aé\x41\n\\q"],
  ])("%s", (lit, want) => {
    expect(unquote(lit)).toBe(want);
  });
});

describe("parsePromQL", () => {
  it("returns undefined for invalid expressions", () => {
    expect(parsePromQL("rate(x[")).toBeUndefined();
    expect(parsePromQL("")).toBeUndefined();
  });

  it("reads selectors with matchers, unwrapping ranges, offsets and parentheses", () => {
    expect(parsePromQL('(x{a="b", c=~"d.*", "e.f"!="", g!~`h`}[5m] offset 1m @ start())')).toEqual({
      kind: "selector",
      name: "x",
      matchers: [
        { name: "a", op: "=", value: "b" },
        { name: "c", op: "=~", value: "d.*" },
        { name: "e.f", op: "!=", value: "" },
        { name: "g", op: "!~", value: "h" },
      ],
      text: 'x{a="b", c=~"d.*", "e.f"!="", g!~`h`}',
    });
    expect(parsePromQL('{__name__="up"}')).toMatchObject({ kind: "selector", name: "up" });
    expect(parsePromQL('{"my.metric", job="a"}')).toMatchObject({ kind: "selector", name: "my.metric" });
  });

  it("reads aggregations with by, without and parameters", () => {
    expect(parsePromQL('sum by (job, "x.y") (rate(x[5m]))')).toMatchObject({
      kind: "aggregate",
      op: "sum",
      by: ["job", "x.y"],
      without: undefined,
      param: undefined,
      expr: { kind: "call", func: "rate", args: [{ kind: "selector", name: "x" }] },
    });
    expect(parsePromQL("count without (cpu) (x)")).toMatchObject({ by: undefined, without: ["cpu"] });
    expect(parsePromQL("sum(x) by (job)")).toMatchObject({ by: ["job"] });
    expect(parsePromQL("sum(x)")).toMatchObject({ by: undefined, without: undefined });
    expect(parsePromQL('count_values("v", x)')).toMatchObject({
      op: "count_values",
      param: { kind: "string", value: "v" },
      expr: { kind: "selector", name: "x" },
    });
  });

  it("reads binary operations with their matching", () => {
    expect(parsePromQL("a / on (job) group_left (team) b > bool 1")).toMatchObject({
      kind: "binary",
      op: ">",
      bool: true,
      lhs: {
        kind: "binary",
        op: "/",
        matching: { on: true, labels: ["job"], card: "many-to-one", include: ["team"], fill: false },
      },
      rhs: { kind: "number" },
    });
    expect(parsePromQL("a and ignoring (x) b")).toMatchObject({
      op: "and",
      matching: { on: false, labels: ["x"], card: "one-to-one", include: [] },
    });
    expect(parsePromQL("a * on () group_right b")).toMatchObject({
      matching: { on: true, labels: [], card: "one-to-many" },
    });
    expect(parsePromQL("a + fill(0) b")).toMatchObject({ matching: { fill: true } });
  });

  it("reads functions, unary minus and comments", () => {
    expect(parsePromQL('label_replace(-x, "dst", "$1", "src", "(.*)")')).toMatchObject({
      kind: "call",
      func: "label_replace",
      args: [
        { kind: "unary", expr: { kind: "selector", name: "x" } },
        { kind: "string", value: "dst" },
        {},
        {},
        {},
      ],
    });
    expect(parsePromQL("# leading comment\nsum(\n  x # inner\n)")).toMatchObject({
      kind: "aggregate",
      expr: { kind: "selector", name: "x" },
    });
    expect(parsePromQL("vector(1)")).toMatchObject({
      kind: "call",
      func: "vector",
      args: [{ kind: "number" }],
    });
  });
});
