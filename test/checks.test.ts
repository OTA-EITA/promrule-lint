import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultOptions, lint, parseTargetLabels, recordIndex } from "../src/checks.js";
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

  const k8s = { ...defaultOptions, targetLabels: parseTargetLabels("kubernetes") };

  it("PR012 and PR013 find the kubernetes-mixin and Prometheus bugs", () => {
    const found = lint(load("labels/bugs.yml"), k8s);
    expect(found.map((f) => `${f.ruleId}:${String(f.line)}`)).toEqual(["PR012:8", "PR013:20"]);
    expect(found[0]?.message).toBe(
      "node:node_cpu_utilization:ratio_rate5m: avg by (cluster, node) groups by node, which its input never has",
    );
    expect(found[0]?.help).toContain("can only carry: cluster, container, cpu, endpoint, instance, job");
    expect(found[1]?.message).toContain(
      "every left-hand series has alertmanager, which the right-hand side never has",
    );
  });

  it("PR012 and PR013 accept the correct kube-prometheus patterns", () => {
    expect(lint(load("labels/fine.yml"), k8s)).toEqual([]);
  });

  it("PR012 depends on the target labels", () => {
    const ids = lint(load("labels/bugs.yml")).map((f) => f.message);
    expect(ids).toContain(
      "node:node_cpu_utilization:ratio_rate5m: avg by (cluster, node) groups by cluster, which its input never has",
    );
  });

  it("PR012 and PR013 describe on, group_left and unless", () => {
    const rec = (expr: string) => `groups:\n- name: g\n  rules:\n  - record: a:b:c\n    expr: '${expr}'\n`;
    const msgs = (expr: string) => lint(parseRuleFile("x", rec(expr))).map((f) => `${f.ruleId} ${f.message}`);
    expect(msgs("node_load1 * on (instance, node) group_left (node) up")).toEqual([
      "PR012 a:b:c: on (node) in node_load1 * on (instance, node) group_left (node) up matches on a label neither side has",
      "PR012 a:b:c: node_load1 * on (instance, node) group_left (node) up copies node from a side that never has it",
    ]);
    expect(msgs("up unless node_cpu_seconds_total")[0]).toMatch(/^PR013 a:b:c: the two sides of unless in/);
    expect(lint(parseRuleFile("x", rec("up unless node_cpu_seconds_total")))[0]?.help).toContain(
      "so unless never removes anything",
    );
  });

  it("resolves recording rules from other files", () => {
    const defs = parseRuleFile(
      "defs.yml",
      "groups:\n- name: g\n  rules:\n  - record: instance:load:max\n    expr: max by (instance) (node_load1)\n",
    );
    const use = parseRuleFile(
      "use.yml",
      "groups:\n- name: g\n  rules:\n  - record: node:load:max\n    expr: max by (node) (instance:load:max)\n",
    );
    expect(lint(use)).toEqual([]);
    expect(lint(use, defaultOptions, recordIndex([defs, use])).map((f) => f.ruleId)).toEqual(["PR012"]);
  });
});

describe("parseTargetLabels", () => {
  it("expands kubernetes and drops duplicates", () => {
    expect(parseTargetLabels(" job, kubernetes,node ,")).toEqual([
      "job",
      "instance",
      "namespace",
      "service",
      "endpoint",
      "pod",
      "container",
      "cluster",
      "node",
    ]);
  });
});
