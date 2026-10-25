import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultOptions, lint } from "../src/checks.js";
import { parseRuleFile } from "../src/parse.js";

const load = (p: string) =>
  parseRuleFile(p, readFileSync(new URL(`./fixtures/${p}`, import.meta.url), "utf8"));
const ids = (src: string, opt = defaultOptions) =>
  lint(parseRuleFile("x", src), opt).map((f) => `${f.ruleId} ${f.target}`);
const alert = (body: string) =>
  `groups:\n- name: g\n  rules:\n  - alert: A\n${body
    .split("\n")
    .map((l) => "    " + l)
    .join("\n")}\n`;
const complete = "labels: {severity: warning}\nannotations: {summary: s, runbook_url: 'https://rb/a'}";

describe("lint", () => {
  it("finds every planted problem in the bad fixture", () => {
    expect(lint(load("bad/rules.yml")).map((f) => `${f.ruleId}:${String(f.line)}`)).toEqual([
      "PR006:4",
      "PR008:16",
      "PR011:32",
      "PR011:33",
      "PR001:4",
      "PR007:8",
      "PR002:16",
      "PR010:22",
      "PR002:33",
      "PR003:4",
      "PR004:4",
      "PR005:4",
      "PR004:8",
      "PR009:30",
      "PR004:33",
      "PR005:33",
    ]);
  });

  it("passes the good fixture when severity none is allowed", () => {
    expect(lint(load("good/rules.yml"), { ...defaultOptions, severities: ["critical", "none"] })).toEqual([]);
  });

  it("honours ignore comments", () => {
    expect(lint(load("operator/prometheusrule.yaml"))).toEqual([]);
  });

  it("PR001 accepts for, but not for: 0", () => {
    expect(ids(alert(`expr: up == 0\nfor: 5m\n${complete}`))).toEqual([]);
    expect(ids(alert(`expr: up == 0\nfor: 0m\n${complete}`))).toEqual(["PR001 A"]);
  });

  it("PR006 follows the scrape interval and factor", () => {
    const src = alert(`expr: rate(x[2m]) > 1\nfor: 5m\n${complete}`);
    expect(ids(src)).toEqual([]);
    expect(ids(src, { ...defaultOptions, minWindowFactor: 4 })).toEqual(["PR006 A"]);
    expect(ids(src, { ...defaultOptions, scrapeIntervalMs: 15_000, minWindowFactor: 4 })).toEqual([]);
    expect(ids(alert(`expr: changes(x[1m]) > 1\nfor: 5m\n${complete}`))).toEqual([]);
  });

  it("PR008 catches aggregation before rate(), not after", () => {
    expect(ids(alert(`expr: increase(sum by (job) (x)[1h:]) > 1\nfor: 5m\n${complete}`))).toEqual([
      "PR008 A",
    ]);
    expect(ids(alert(`expr: sum by (job) (increase(x[1h])) > 1\nfor: 5m\n${complete}`))).toEqual([]);
  });

  it("PR009 only flags recording rules without a colon", () => {
    const rec = (n: string) => `groups:\n- name: g\n  rules:\n  - record: ${n}\n    expr: up\n`;
    expect(ids(rec("job:up:sum"))).toEqual([]);
    expect(ids(rec(":node_memory:sum"))).toEqual([]);
    expect(ids(rec("up_sum"))).toEqual(["PR009 up_sum"]);
  });

  it("PR010 does not flag variants with different labels", () => {
    const two = `groups:\n- name: g\n  rules:\n  - alert: A\n    expr: x > 1\n    for: 5m\n    labels: {severity: warning}\n    annotations: {summary: s, runbook_url: 'https://rb/a'}\n  - alert: A\n    expr: x > 2\n    for: 5m\n    labels: {severity: critical}\n    annotations: {summary: s, runbook_url: 'https://rb/a'}\n`;
    expect(ids(two)).toEqual([]);
  });

  it("reports unreadable files as PR011", () => {
    expect(lint(parseRuleFile("x", "foo: 1\n"))).toMatchObject([{ ruleId: "PR011", line: 1, target: "x" }]);
  });
});
