import { describe, expect, it } from "vitest";
import { parsePromQL } from "../src/ast.js";
import type { Expr } from "../src/ast.js";
import { LabelInference, neverMatches, valueType } from "../src/labels.js";
import type { Issue, LabelSet, MetricInfo, RecordDef } from "../src/labels.js";

const metrics = new Map<string, MetricInfo>([
  ["cpu_seconds_total", { labels: ["cpu", "mode"], always: ["cpu", "mode"] }],
  ["queue_length", { labels: ["alertmanager"], always: ["alertmanager"] }],
  ["queue_capacity", { labels: [], always: [] }],
  ["pod_info", { labels: ["namespace", "pod", "node"], always: ["namespace", "pod"] }],
  ["req_bucket", { labels: ["code", "le"], always: ["code", "le"] }],
  ["failed_total", { labels: ["integration", "reason"], always: ["integration", "reason"] }],
  ["sent_total", { labels: ["integration"], always: ["integration"] }],
]);

const expr = (s: string): Expr => {
  const e = parsePromQL(s);
  if (!e) throw new Error(`does not parse: ${s}`);
  return e;
};

function setup(records: Record<string, string | string[]> = {}, targetLabels = ["job", "instance"]) {
  const index = new Map<string, RecordDef[]>();
  for (const [name, defs] of Object.entries(records)) {
    index.set(
      name,
      (Array.isArray(defs) ? defs : [defs]).map((d) => {
        const [e, labels] = d.split(" @ ");
        return {
          expr: parsePromQL(e ?? ""),
          labels: labels ? (JSON.parse(labels) as Record<string, string>) : {},
        };
      }),
    );
  }
  return new LabelInference({ metrics, targetLabels, records: index });
}

/** Inferred labels as a compact string: "a b!" means a may be present and b always is; "?" is unknown. */
function show(l: LabelSet): string {
  if (!l.known) return "?";
  return [...l.may]
    .sort()
    .map((n) => (l.must.has(n) ? `${n}!` : n) + (l.fixed.has(n) ? `=${l.fixed.get(n) ?? ""}` : ""))
    .join(" ");
}

const labelsOf = (s: string, inf = setup()) => show(inf.infer(expr(s)));

function issues(s: string, inf = setup()): string[] {
  const out: Issue[] = [];
  inf.infer(expr(s), (i) => out.push(i));
  return out.map((i) => `${i.kind}:${i.kind === "nomatch" ? i.reason : i.label}`);
}

describe("label inference", () => {
  it("adds target labels to known metrics and leaves unknown ones unknown", () => {
    expect(labelsOf("cpu_seconds_total")).toBe("cpu! instance job mode!");
    expect(labelsOf("some_other_metric")).toBe("?");
    expect(labelsOf('{job="x"}')).toBe("?");
  });

  it("applies matchers", () => {
    expect(labelsOf('pod_info{node!="", namespace="", job="ksm"}')).toBe("instance job!=ksm node! pod!");
    expect(labelsOf('pod_info{node=~".+", pod=~".*", instance!~"", job!="x"}')).toBe(
      "instance! job namespace! node! pod!",
    );
    // A pattern JavaScript cannot read is left alone.
    expect(labelsOf('pod_info{node=~"(?P<x>a)"}')).toBe("instance job namespace! node pod!");
  });

  it("keeps a colliding exporter label as exported_<name>", () => {
    expect(labelsOf("pod_info", setup({}, ["job", "namespace"]))).toBe(
      "exported_namespace job namespace! node pod!",
    );
  });

  it("follows aggregations", () => {
    expect(labelsOf("sum by (mode, nope) (cpu_seconds_total)")).toBe("mode!");
    expect(labelsOf("sum without (cpu) (cpu_seconds_total)")).toBe("instance job mode!");
    expect(labelsOf("sum(cpu_seconds_total)")).toBe("");
    expect(labelsOf("topk by (mode) (1, cpu_seconds_total)")).toBe("cpu! instance job mode!");
    expect(labelsOf('count_values by (mode) ("value", cpu_seconds_total)')).toBe("mode! value!");
    expect(labelsOf("sum by (a) (unknown_metric)")).toBe("a");
    expect(labelsOf("sum without (a) (unknown_metric)")).toBe("?");
  });

  it("follows functions", () => {
    expect(labelsOf("rate(cpu_seconds_total[5m])")).toBe("cpu! instance job mode!");
    expect(labelsOf("predict_linear(queue_length[5m], 60 * 30)")).toBe("alertmanager! instance job");
    expect(labelsOf("histogram_quantile(0.9, rate(req_bucket[5m]))")).toBe("code! instance job");
    expect(labelsOf('label_replace(cpu_seconds_total, "cpu", "$1", "x", "(.*)")')).toBe(
      "cpu instance job mode!",
    );
    expect(labelsOf('label_join(queue_capacity, "dst", ",", "a")')).toBe("dst instance job");
    expect(labelsOf("label_replace(cpu_seconds_total, dst, '', '', '')")).toBe("?");
    expect(labelsOf("vector(1)")).toBe("");
    expect(labelsOf("scalar(cpu_seconds_total)")).toBe("");
    expect(labelsOf("day_of_month()")).toBe("");
    expect(labelsOf('absent(cpu_seconds_total{mode="idle", cpu=~"1"})')).toBe("mode!=idle");
    expect(labelsOf("absent(sum(x))")).toBe("");
    expect(labelsOf("info(cpu_seconds_total)")).toBe("?");
    expect(labelsOf("rate(unknown_metric[5m])")).toBe("?");
  });

  it("follows binary operations", () => {
    expect(labelsOf("1 + 2")).toBe("");
    expect(labelsOf("-queue_length * 2")).toBe("alertmanager! instance job");
    expect(labelsOf("2 * queue_length")).toBe("alertmanager! instance job");
    expect(labelsOf("queue_length / on (job) queue_capacity")).toBe("job");
    expect(labelsOf("unknown_metric / on (job) queue_capacity")).toBe("job");
    expect(labelsOf("queue_length / ignoring (alertmanager) queue_capacity")).toBe("instance job");
    expect(labelsOf("unknown_metric / ignoring (job) queue_capacity")).toBe("?");
    expect(labelsOf("cpu_seconds_total * on (instance) group_left (node, nope) pod_info")).toBe(
      "cpu! instance job mode! node",
    );
    expect(labelsOf("cpu_seconds_total * on (instance) group_left (node) unknown_metric")).toBe(
      "cpu! instance job mode! node",
    );
    expect(labelsOf("pod_info * on (instance) group_right (node) cpu_seconds_total")).toBe(
      "cpu! instance job mode! node",
    );
    expect(labelsOf("unknown_metric * on (instance) group_left (node) pod_info")).toBe("?");
    expect(
      labelsOf('queue_length{alertmanager="a"} * on (job) group_right (alertmanager) queue_capacity'),
    ).toBe("alertmanager!=a instance job");
    expect(labelsOf("queue_length and queue_capacity")).toBe("alertmanager! instance job");
    expect(labelsOf("queue_length or queue_capacity")).toBe("alertmanager instance job");
    expect(labelsOf("queue_length or unknown_metric")).toBe("?");
  });

  it("resolves recording rules, their labels and every definition", () => {
    const inf = setup({
      "job:cpu:sum": 'sum by (job, mode) (cpu_seconds_total) @ {"team": "a", "mode": ""}',
      "two:defs": [
        'sum by (job) (queue_length) @ {"src": "a"}',
        'sum by (instance) (queue_length) @ {"src": "b"}',
      ],
      "a:loop": "sum by (x) (b:loop)",
      "b:loop": "a:loop",
      "bad:expr": "rate(",
      "half:bad": ["sum by (job) (queue_length)", "rate("],
    });
    expect(labelsOf("job:cpu:sum", inf)).toBe("job team!=a");
    expect(labelsOf('job:cpu:sum{team="a", job="j"}', inf)).toBe("job!=j team!=a");
    expect(labelsOf("two:defs", inf)).toBe("instance job src!");
    expect(labelsOf("a:loop", inf)).toBe("x");
    // The cycle is cut where it is found, so b:loop stays unknown.
    expect(labelsOf("b:loop", inf)).toBe("?");
    expect(labelsOf("bad:expr", inf)).toBe("?");
    expect(labelsOf("half:bad", inf)).toBe("?");
  });
});

describe("label issues", () => {
  it("reports by() labels the input never has", () => {
    expect(issues("avg by (node) (sum without (mode) (rate(cpu_seconds_total[5m])))")).toEqual(["by:node"]);
    expect(issues("sum by (cpu, __name__) (cpu_seconds_total)")).toEqual([]);
    expect(issues("sum by (node) (unknown_metric)")).toEqual([]);
  });

  it("reports on() and group_left() labels that are never there", () => {
    expect(issues("cpu_seconds_total * on (instance, node) group_left (node) queue_capacity")).toEqual([
      "on:node",
      "include:node",
    ]);
    expect(issues("pod_info * on (instance) group_right (node) cpu_seconds_total")).toEqual([]);
    expect(issues("queue_capacity * on (instance) group_right (node) cpu_seconds_total")).toEqual([
      "include:node",
    ]);
    expect(issues("cpu_seconds_total * on (node) group_left (node) unknown_metric")).toEqual([]);
  });

  it("reports vector matches that can never succeed", () => {
    expect(issues("predict_linear(queue_length[5m], 60) > min_over_time(queue_capacity[5m])")).toEqual([
      "nomatch:every left-hand series has alertmanager, which the right-hand side never has",
    ]);
    expect(issues("queue_capacity unless queue_length")).toEqual([
      "nomatch:every right-hand series has alertmanager, which the left-hand side never has",
    ]);
    expect(issues('queue_length{job="a"} - on (job) queue_length{job="b"}')).toEqual([
      'nomatch:job is "a" on the left and "b" on the right',
    ]);
    expect(issues("rate(failed_total[5m]) / ignoring (reason) group_left rate(sent_total[5m])")).toEqual([]);
    expect(issues("rate(failed_total[5m]) / rate(sent_total[5m])")).toEqual([
      "nomatch:every left-hand series has reason, which the right-hand side never has",
    ]);
    expect(issues("queue_length > on (instance) queue_capacity")).toEqual([]);
    expect(issues("queue_length or queue_capacity")).toEqual([]);
    expect(issues("queue_length + fill(0) queue_capacity")).toEqual([]);
    expect(issues("queue_length > unknown_metric")).toEqual([]);
    expect(issues("queue_length > 1")).toEqual([]);
  });
});

describe("helpers", () => {
  it("valueType", () => {
    expect(valueType(expr('"a"'))).toBe("string");
    expect(valueType(expr("-time()"))).toBe("scalar");
    expect(valueType(expr("1 + x"))).toBe("vector");
  });

  it("neverMatches needs both sides known", () => {
    const known = setup().infer(expr("queue_length"));
    const unknown = setup().infer(expr("x"));
    const m = { on: false, labels: [], card: "one-to-one" as const, include: [], fill: false };
    expect(neverMatches(known, unknown, m)).toBeUndefined();
  });
});
