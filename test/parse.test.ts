import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ignoredChecks, parseRuleFile } from "../src/parse.js";

const fixture = (p: string) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), "utf8");

describe("parseRuleFile", () => {
  it("reads alerts and recording rules with line numbers", () => {
    const f = parseRuleFile("rules.yml", fixture("good/rules.yml"));
    expect(f.errors).toEqual([]);
    expect(f.rules.map((r) => [r.kind, r.name, r.line])).toEqual([
      ["record", "job:http_requests:rate5m", 4],
      ["alert", "HighErrorRate", 6],
      ["alert", "Watchdog", 14],
    ]);
    expect(f.rules[1]).toMatchObject({ for: "10m", group: "api", labels: { severity: "critical" } });
  });

  it("reads PrometheusRule resources and skips other documents", () => {
    const f = parseRuleFile("p.yaml", fixture("operator/prometheusrule.yaml"));
    expect(f.errors).toEqual([]);
    expect(f.rules.map((r) => [r.name, r.ignore])).toEqual([
      ["QueueStuck", ["PR004"]],
      ["QueueSlow", ["ALL"]],
    ]);
  });

  it("records structural problems", () => {
    const f = parseRuleFile(
      "x",
      "groups:\n- name: g\n  rules:\n  - alert: A\n  - alert: B\n    record: b\n    expr: up\n  - expr: up\n  - alert: C\n    expr: up\n    for: {a: 1}\n",
    );
    expect(f.rules.map((r) => r.errors)).toEqual([
      ["has no expr"],
      ["has both alert and record"],
      ["has neither alert nor record"],
      ["has a for that is not a duration"],
    ]);
  });

  it("reports YAML errors and files without groups", () => {
    expect(parseRuleFile("x", "groups: [\n").errors[0]?.line).toBe(2); // the unclosed bracket is reported at the end of input
    expect(parseRuleFile("x", "foo: 1\n").errors).toEqual([{ line: 1, message: "no groups found" }]);
    expect(parseRuleFile("x", "").rules).toEqual([]);
  });

  it("keeps numeric expressions and for values", () => {
    const f = parseRuleFile("x", "groups:\n- name: g\n  rules:\n  - alert: A\n    expr: 1\n    for: 0\n");
    expect(f.rules[0]).toMatchObject({ expr: "1", for: "0" });
  });
});

describe("ignoredChecks", () => {
  it("collects ids from one or more comments", () => {
    expect(
      ignoredChecks("# reason; promrule-lint-ignore PR001, pr004\n# promrule-lint-ignore PR009"),
    ).toEqual(["PR001", "PR004", "PR009"]);
    expect(ignoredChecks("# nothing here")).toEqual([]);
  });
});
