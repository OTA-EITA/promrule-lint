import { LineCounter, parseAllDocuments } from "yaml";

export interface Rule {
  kind: "alert" | "record";
  /** Alert or record name ("" when missing). */
  name: string;
  expr: string;
  for?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  group: string;
  line: number;
  /** Structural problems found while reading the rule. */
  errors: string[];
}

export interface RuleFile {
  file: string;
  rules: Rule[];
  errors: { line: number; message: string }[];
}

function strMap(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? x : String(x)]));
}

/**
 * Reads Prometheus rule files and Kubernetes PrometheusRule resources
 * (prometheus-operator), including multi-document YAML.
 */
export function parseRuleFile(file: string, source: string): RuleFile {
  const lc = new LineCounter();
  const out: RuleFile = { file, rules: [], errors: [] };
  const lineAt = (offset: number | undefined) => (offset === undefined ? 1 : lc.linePos(offset).line);

  for (const doc of parseAllDocuments(source, { lineCounter: lc })) {
    if (doc.errors.length) {
      for (const e of doc.errors)
        out.errors.push({ line: lineAt(e.pos[0]), message: e.message.split("\n")[0] ?? "" });
      continue;
    }
    const data: unknown = doc.toJS();
    if (typeof data !== "object" || data === null) continue;
    const root = data as Record<string, unknown>;
    const isOperator = root.kind === "PrometheusRule";
    // Other Kubernetes objects in the same stream are not rule files.
    if (!isOperator && "kind" in root) continue;
    const base = isOperator ? ["spec", "groups"] : ["groups"];
    const groups = isOperator ? (root.spec as Record<string, unknown> | undefined)?.groups : root.groups;
    if (!Array.isArray(groups)) {
      out.errors.push({ line: lineAt(doc.contents?.range[0]), message: "no groups found" });
      continue;
    }

    groups.forEach((g: unknown, gi) => {
      const group = (g ?? {}) as Record<string, unknown>;
      const groupName = typeof group.name === "string" ? group.name : `group ${String(gi)}`;
      if (!Array.isArray(group.rules)) return;
      group.rules.forEach((r: unknown, ri) => {
        const node = doc.getIn([...base, gi, "rules", ri], true) as
          { range?: [number, number, number] } | undefined;
        const raw = (r ?? {}) as Record<string, unknown>;
        const errors: string[] = [];
        const isAlert = typeof raw.alert === "string";
        const isRecord = typeof raw.record === "string";
        if (isAlert && isRecord) errors.push("has both alert and record");
        if (!isAlert && !isRecord) errors.push("has neither alert nor record");
        if (typeof raw.expr !== "string" && typeof raw.expr !== "number") errors.push("has no expr");
        const rule: Rule = {
          kind: isRecord && !isAlert ? "record" : "alert",
          name: ((isAlert ? raw.alert : raw.record) as string | undefined) ?? "",
          expr: typeof raw.expr === "string" || typeof raw.expr === "number" ? String(raw.expr) : "",
          labels: strMap(raw.labels),
          annotations: strMap(raw.annotations),
          group: groupName,
          line: lineAt(node?.range?.[0]),
          errors,
        };
        if (typeof raw.for === "string" || typeof raw.for === "number") rule.for = String(raw.for);
        else if (raw.for !== undefined && raw.for !== null) errors.push("has a for that is not a duration");
        out.rules.push(rule);
      });
    });
  }
  return out;
}
