// Label-set inference: which label names each part of an expression can carry.
// Anything that depends on a metric we know nothing about stays unknown, and
// unknown sets never produce findings.
import type { Expr, Matcher, Matching } from "./ast.js";

export interface LabelSet {
  /** false when the labels cannot be known (e.g. a metric missing from the table). */
  known: boolean;
  /** Labels a series may carry. */
  may: Set<string>;
  /** Labels every series carries with a non-empty value (a subset of may). */
  must: Set<string>;
  /** Values pinned by equality matchers or recording rule labels. */
  fixed: Map<string, string>;
}

export interface MetricInfo {
  labels: string[];
  /** Labels that are never empty, so every series has them. */
  always: string[];
}

export interface RecordDef {
  /** undefined when the expression does not parse. */
  expr: Expr | undefined;
  labels: Record<string, string>;
}

export interface LabelEnv {
  metrics: ReadonlyMap<string, MetricInfo>;
  /** Labels the scrape adds to every series (job, instance, Kubernetes service discovery labels). */
  targetLabels: string[];
  /** Recording rules by name; one name may be defined more than once. */
  records: ReadonlyMap<string, RecordDef[]>;
}

export type Issue =
  /** A by (...) label that the aggregation's input never has. */
  | { kind: "by"; label: string; node: Extract<Expr, { kind: "aggregate" }>; input: LabelSet }
  /** An on (...) label that neither side ever has. */
  | { kind: "on"; label: string; node: Expr; lhs: LabelSet; rhs: LabelSet }
  /** A group_left/group_right (...) label the "one" side never has. */
  | { kind: "include"; label: string; node: Expr; one: LabelSet }
  /** A vector match whose two sides can never have the same matching labels. */
  | {
      kind: "nomatch";
      reason: string;
      node: Extract<Expr, { kind: "binary" }>;
      lhs: LabelSet;
      rhs: LabelSet;
    };

const unknown = (): LabelSet => ({ known: false, may: new Set(), must: new Set(), fixed: new Map() });
const empty = (): LabelSet => ({ known: true, may: new Set(), must: new Set(), fixed: new Map() });
const clone = (l: LabelSet): LabelSet => ({
  known: l.known,
  may: new Set(l.may),
  must: new Set(l.must),
  fixed: new Map(l.fixed),
});

function drop(l: LabelSet, names: Iterable<string>): void {
  for (const n of names) {
    l.may.delete(n);
    l.must.delete(n);
    l.fixed.delete(n);
  }
}

function keepOnly(l: LabelSet, names: string[]): LabelSet {
  const keep = new Set(names);
  return {
    known: true,
    may: new Set([...l.may].filter((n) => keep.has(n))),
    must: new Set([...l.must].filter((n) => keep.has(n))),
    fixed: new Map([...l.fixed].filter(([n]) => keep.has(n))),
  };
}

/** Whether an RE2 pattern, fully anchored as Prometheus does, matches the empty string; undefined if unsure. */
function matchesEmpty(pattern: string): boolean | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`).test("");
  } catch {
    return undefined;
  }
}

/** Applies a selector's matchers: an empty value removes a label, a non-empty one guarantees it. */
function applyMatchers(l: LabelSet, matchers: Matcher[]): void {
  for (const m of matchers) {
    if (m.name === "__name__") continue;
    let present: boolean | undefined;
    if (m.op === "=") present = m.value !== "";
    else if (m.op === "!=") present = m.value === "" ? true : undefined;
    else {
      const empty = matchesEmpty(m.value);
      if (empty !== undefined) present = m.op === "=~" ? (empty ? undefined : true) : empty || undefined;
    }
    if (present === false) drop(l, [m.name]);
    if (present) {
      l.may.add(m.name);
      l.must.add(m.name);
    }
    if (m.op === "=" && present) l.fixed.set(m.name, m.value);
  }
}

type ValueType = "scalar" | "vector" | "string";

const scalarFunctions = new Set([
  "scalar",
  "time",
  "pi",
  "range",
  "step",
  "start",
  "end",
  "min_of",
  "max_of",
]);
const noLabelFunctions = new Set(["vector", ...scalarFunctions]);
// Functions that drop the le label of classic histogram buckets.
const histogramFunctions = new Set(["histogram_quantile", "histogram_fraction"]);
// Functions whose output labels cannot be derived from their arguments.
const opaqueFunctions = new Set(["info", "histogram_quantiles"]);
const keepInput = new Set(["topk", "bottomk", "limitk", "limit_ratio"]);

export function valueType(e: Expr): ValueType {
  switch (e.kind) {
    case "number":
      return "scalar";
    case "string":
      return "string";
    case "unary":
      return valueType(e.expr);
    case "binary":
      return valueType(e.lhs) === "vector" || valueType(e.rhs) === "vector" ? "vector" : "scalar";
    case "call":
      return scalarFunctions.has(e.func) ? "scalar" : "vector";
    default:
      return "vector";
  }
}

/** Labels a group_left/group_right result takes: the "many" side's, with the included labels from the "one" side. */
function joinResult(many: LabelSet, one: LabelSet, include: string[]): LabelSet {
  if (!many.known) return unknown();
  const out = clone(many);
  drop(out, include);
  for (const n of include) {
    if (!one.known || one.may.has(n)) out.may.add(n);
    if (one.known && one.must.has(n)) out.must.add(n);
    const v = one.known ? one.fixed.get(n) : undefined;
    if (v !== undefined) out.fixed.set(n, v);
  }
  return out;
}

/** Why the two sides of a vector match can never pair up, or undefined if they might. */
export function neverMatches(lhs: LabelSet, rhs: LabelSet, m: Matching): string | undefined {
  if (!lhs.known || !rhs.known) return undefined;
  const inSignature = (n: string) =>
    n !== "__name__" && (m.on ? m.labels.includes(n) : !m.labels.includes(n));
  const sides: [LabelSet, LabelSet, string, string][] = [
    [lhs, rhs, "left", "right"],
    [rhs, lhs, "right", "left"],
  ];
  for (const [a, b, an, bn] of sides) {
    for (const n of [...a.must].sort()) {
      if (inSignature(n) && !b.may.has(n)) {
        return `every ${an}-hand series has ${n}, which the ${bn}-hand side never has`;
      }
    }
  }
  for (const [n, v] of [...lhs.fixed].sort()) {
    const w = rhs.fixed.get(n);
    if (inSignature(n) && w !== undefined && w !== v && lhs.must.has(n) && rhs.must.has(n)) {
      return `${n} is "${v}" on the left and "${w}" on the right`;
    }
  }
  return undefined;
}

export class LabelInference {
  private readonly memo = new Map<string, LabelSet>();
  private readonly resolving = new Set<string>();

  constructor(private readonly env: LabelEnv) {}

  /** Labels of the expression's result; problems found on the way are passed to report. */
  infer(e: Expr, report: (i: Issue) => void = () => undefined): LabelSet {
    switch (e.kind) {
      case "number":
      case "string":
        return empty();
      case "unary":
        return this.infer(e.expr, report);
      case "selector":
        return this.selector(e.name, e.matchers);
      case "aggregate":
        return this.aggregate(e, report);
      case "call":
        return this.call(e, report);
      case "binary":
        return this.binary(e, report);
    }
  }

  /** Labels of a recording rule's series, combining every definition of the name. */
  record(name: string): LabelSet {
    const cached = this.memo.get(name);
    if (cached) return cached;
    if (this.resolving.has(name)) return unknown(); // a cycle: leave it unknown
    this.resolving.add(name);
    let out: LabelSet | undefined;
    for (const def of this.env.records.get(name) ?? []) {
      const l = def.expr ? clone(this.infer(def.expr)) : unknown();
      for (const [k, v] of Object.entries(def.labels)) {
        l.may.add(k);
        if (v === "") drop(l, [k]);
        else {
          l.must.add(k);
          l.fixed.set(k, v);
        }
      }
      out = out ? union(out, l) : l;
    }
    this.resolving.delete(name);
    const result = out ?? unknown();
    this.memo.set(name, result);
    return result;
  }

  private selector(name: string | undefined, matchers: Matcher[]): LabelSet {
    if (name === undefined) return unknown();
    let l: LabelSet;
    if (this.env.records.has(name)) l = clone(this.record(name));
    else {
      const info = this.env.metrics.get(name);
      if (!info) return unknown();
      l = empty();
      for (const n of info.labels) l.may.add(n);
      for (const n of info.always) l.must.add(n);
      for (const n of this.env.targetLabels) {
        // A label the exporter sets and the scrape also sets is kept as exported_<name> (or
        // overwritten with honor_labels), so both names may appear.
        if (l.may.has(n)) l.may.add(`exported_${n}`);
        l.may.add(n);
      }
    }
    if (!l.known) return l;
    applyMatchers(l, matchers);
    return l;
  }

  private aggregate(e: Extract<Expr, { kind: "aggregate" }>, report: (i: Issue) => void): LabelSet {
    if (e.param) this.infer(e.param, report);
    const input = this.infer(e.expr, report);
    if (input.known) {
      for (const n of e.by ?? []) {
        if (n !== "__name__" && !input.may.has(n)) report({ kind: "by", label: n, node: e, input });
      }
    }
    if (keepInput.has(e.op)) return input;
    let out: LabelSet;
    if (e.without) {
      if (!input.known) return input;
      out = clone(input);
      drop(out, e.without);
    } else if (e.by) {
      out = input.known ? keepOnly(input, e.by) : { ...empty(), may: new Set(e.by) };
    } else out = empty();
    if (e.op === "count_values" && e.param?.kind === "string") {
      out.may.add(e.param.value);
      out.must.add(e.param.value);
      out.fixed.delete(e.param.value);
    }
    return out;
  }

  private call(e: Extract<Expr, { kind: "call" }>, report: (i: Issue) => void): LabelSet {
    const args = e.args.map((a) => this.infer(a, report));
    if (noLabelFunctions.has(e.func)) return empty();
    if (e.func === "absent" || e.func === "absent_over_time") {
      // absent() returns one series labelled from the selector's equality matchers.
      const out = empty();
      const arg = e.args[0];
      if (arg?.kind === "selector") {
        for (const m of arg.matchers) {
          if (m.op === "=" && m.name !== "__name__" && m.value !== "") {
            out.may.add(m.name);
            out.must.add(m.name);
            out.fixed.set(m.name, m.value);
          }
        }
      }
      return out;
    }
    if (opaqueFunctions.has(e.func) || e.func.startsWith("<")) return unknown();
    const i = e.args.findIndex((a) => valueType(a) === "vector");
    const input = args[i];
    if (!input) return empty(); // e.g. day_of_month() without arguments works on vector(time())
    if (!input.known) return input;
    const out = clone(input);
    if (e.func === "label_replace" || e.func === "label_join") {
      const dst = e.args[1];
      if (dst?.kind !== "string") return unknown();
      drop(out, [dst.value]);
      out.may.add(dst.value);
    }
    if (histogramFunctions.has(e.func)) drop(out, ["le"]);
    return out;
  }

  private binary(e: Extract<Expr, { kind: "binary" }>, report: (i: Issue) => void): LabelSet {
    const lhs = this.infer(e.lhs, report);
    const rhs = this.infer(e.rhs, report);
    const lv = valueType(e.lhs) === "vector";
    const rv = valueType(e.rhs) === "vector";
    if (!lv && !rv) return empty();
    if (!lv) return rhs;
    if (!rv) return lhs;

    const m = e.matching;
    if (lhs.known && rhs.known && m.on) {
      for (const n of m.labels) {
        if (!lhs.may.has(n) && !rhs.may.has(n)) report({ kind: "on", label: n, node: e, lhs, rhs });
      }
    }
    const one = m.card === "many-to-one" ? rhs : lhs;
    if (m.card !== "one-to-one" && one.known) {
      for (const n of m.include) {
        if (!one.may.has(n)) report({ kind: "include", label: n, node: e, one });
      }
    }
    if (e.op !== "or" && !m.fill) {
      const reason = neverMatches(lhs, rhs, m);
      if (reason) report({ kind: "nomatch", reason, node: e, lhs, rhs });
    }

    if (e.op === "or") return lhs.known && rhs.known ? union(lhs, rhs) : unknown();
    if (e.op === "and" || e.op === "unless") return lhs;
    if (m.card === "many-to-one") return joinResult(lhs, rhs, m.include);
    if (m.card === "one-to-many") return joinResult(rhs, lhs, m.include);
    if (m.on) return lhs.known ? keepOnly(lhs, m.labels) : { ...empty(), may: new Set(m.labels) };
    if (!lhs.known) return lhs;
    const out = clone(lhs);
    drop(out, m.labels);
    return out;
  }
}

/** Series that come from either of two sets: any label of either may appear, only shared ones always do. */
function union(a: LabelSet, b: LabelSet): LabelSet {
  if (!a.known || !b.known) return unknown();
  return {
    known: true,
    may: new Set([...a.may, ...b.may]),
    must: new Set([...a.must].filter((n) => b.must.has(n))),
    fixed: new Map([...a.fixed].filter(([n, v]) => b.fixed.get(n) === v)),
  };
}
