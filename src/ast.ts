// A small typed view of PromQL expressions, built from the official Prometheus
// grammar (@prometheus-io/lezer-promql). Only what the label checks need is kept;
// offsets, @ modifiers and ranges are unwrapped because they do not change labels.
import type { SyntaxNode } from "@lezer/common";
import { parser } from "@prometheus-io/lezer-promql";

export type MatchOp = "=" | "!=" | "=~" | "!~";

export interface Matcher {
  name: string;
  op: MatchOp;
  value: string;
}

export interface Matching {
  /** true for on(...), false for ignoring(...) or no modifier. */
  on: boolean;
  labels: string[];
  card: "one-to-one" | "many-to-one" | "one-to-many";
  /** Labels listed in group_left(...) / group_right(...). */
  include: string[];
  /** A fill() modifier fills in missing series, so unmatched sides still produce output. */
  fill: boolean;
}

export type Expr =
  | { kind: "number"; text: string }
  | { kind: "string"; value: string; text: string }
  | { kind: "selector"; name: string | undefined; matchers: Matcher[]; text: string }
  | {
      kind: "aggregate";
      op: string;
      /** by (...) labels, or undefined when the aggregation uses without or no modifier. */
      by: string[] | undefined;
      without: string[] | undefined;
      param: Expr | undefined;
      expr: Expr;
      text: string;
    }
  | { kind: "call"; func: string; args: Expr[]; text: string }
  | { kind: "binary"; op: string; bool: boolean; lhs: Expr; rhs: Expr; matching: Matching; text: string }
  | { kind: "unary"; expr: Expr; text: string };

/** Decodes a PromQL string literal: "..." and '...' with Go escapes, or `raw`. */
export function unquote(lit: string): string {
  const quote = lit.charAt(0);
  const body = lit.slice(1, -1);
  if (quote === "`") return body;
  const simple: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    '"': '"',
    "'": "'",
  };
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{3}|.)/g, (m, e: string) => {
    const c = e.charAt(0);
    if (c === "x" || c === "u" || c === "U") return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/[0-7]/.test(c)) return String.fromCodePoint(parseInt(e, 8));
    return simple[e] ?? m;
  });
}

const children = (n: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) if (c.name !== "LineComment") out.push(c);
  return out;
};

const transparent = new Set([
  "ParenExpr",
  "MatrixSelector",
  "SubqueryExpr",
  "OffsetExpr",
  "StepInvariantExpr",
  "AnchoredExpr",
  "SmoothedExpr",
]);

const binaryOps = new Set([
  "Pow",
  "Mul",
  "Div",
  "Mod",
  "Atan2",
  "Add",
  "Sub",
  "Eql",
  "Gte",
  "Gtr",
  "Lte",
  "Lss",
  "Neq",
  "TrimUpper",
  "TrimLower",
  "And",
  "Or",
  "Unless",
]);

/** Parses a PromQL expression, or returns undefined when it does not parse. */
export function parsePromQL(src: string): Expr | undefined {
  const tree = parser.parse(src);
  for (const c = tree.cursor(); c.next();) if (c.type.isError) return undefined;
  const top = children(tree.topNode)[0];
  if (!top) return undefined;

  const text = (n: SyntaxNode) => src.slice(n.from, n.to);
  const labelName = (n: SyntaxNode): string => {
    const lit = n.name === "QuotedLabelName" ? n.firstChild : null;
    return lit ? unquote(text(lit)) : text(n);
  };
  const grouping = (n: SyntaxNode | null): string[] =>
    n
      ? children(n)
          .filter((c) => c.name === "LabelName" || c.name === "QuotedLabelName")
          .map(labelName)
      : [];

  const selector = (n: SyntaxNode): Expr => {
    let name: string | undefined;
    const matchers: Matcher[] = [];
    for (const c of children(n)) {
      if (c.name === "Identifier") name = text(c);
      if (c.name !== "LabelMatchers") continue;
      for (const m of children(c)) {
        if (m.name === "QuotedLabelName") {
          // {"metric.name"}: a quoted metric name inside the braces.
          name = labelName(m);
          continue;
        }
        const parts = children(m);
        const op = parts.find((p) => p.name === "MatchOp");
        const value = parts.find((p) => p.name === "StringLiteral");
        const label = parts[0];
        if (!op || !value || !label) continue;
        matchers.push({ name: labelName(label), op: text(op) as MatchOp, value: unquote(text(value)) });
      }
    }
    const metric = matchers.find((m) => m.name === "__name__" && m.op === "=");
    if (name === undefined && metric) name = metric.value;
    return { kind: "selector", name, matchers, text: text(n) };
  };

  const build = (n: SyntaxNode): Expr => {
    const t = text(n);
    if (transparent.has(n.name)) {
      const inner = children(n)[0];
      return inner ? build(inner) : { kind: "number", text: t };
    }
    switch (n.name) {
      case "NumberDurationLiteral":
        return { kind: "number", text: t };
      case "StringLiteral":
        return { kind: "string", value: unquote(t), text: t };
      case "VectorSelector":
        return selector(n);
      case "UnaryExpr": {
        const inner = children(n).pop();
        return { kind: "unary", expr: inner ? build(inner) : { kind: "number", text: t }, text: t };
      }
      case "FunctionCall": {
        const id = n.getChild("FunctionIdentifier");
        const body = n.getChild("FunctionCallBody");
        return {
          kind: "call",
          func: id ? text(id) : "",
          args: body ? children(body).map(build) : [],
          text: t,
        };
      }
      case "AggregateExpr": {
        const op = n.getChild("AggregateOp");
        const mod = n.getChild("AggregateModifier");
        const body = n.getChild("FunctionCallBody");
        const args = body ? children(body).map(build) : [];
        const labels = grouping(mod?.getChild("GroupingLabels") ?? null);
        const isWithout = mod?.getChild("Without") != null;
        return {
          kind: "aggregate",
          op: op ? text(op).toLowerCase() : "",
          by: mod && !isWithout ? labels : undefined,
          without: isWithout ? labels : undefined,
          param: args.length > 1 ? args[0] : undefined,
          expr: args[args.length - 1] ?? { kind: "number", text: "" },
          text: t,
        };
      }
      case "BinaryExpr": {
        const parts = children(n);
        const opNode = parts.find((p) => binaryOps.has(p.name));
        const clause = n.getChild("MatchingModifierClause");
        const matching: Matching = { on: false, labels: [], card: "one-to-one", include: [], fill: false };
        if (clause) {
          const groups = clause.getChildren("GroupingLabels");
          matching.on = clause.getChild("On") != null;
          matching.labels = grouping(groups[0] ?? null);
          if (clause.getChild("GroupLeft")) matching.card = "many-to-one";
          if (clause.getChild("GroupRight")) matching.card = "one-to-many";
          matching.include = grouping(groups[1] ?? null);
        }
        matching.fill = n.getChild("FillModifier") != null;
        const first = parts[0];
        const last = parts[parts.length - 1];
        return {
          kind: "binary",
          op: opNode ? text(opNode).toLowerCase() : "",
          bool: n.getChild("BoolModifier") != null,
          lhs: first ? build(first) : { kind: "number", text: "" },
          rhs: last ? build(last) : { kind: "number", text: "" },
          matching,
          text: t,
        };
      }
    }
    // Anything else (a construct added to the grammar later) is kept as an expression the
    // checks know nothing about. Every current expression node is handled above.
    /* v8 ignore next */
    return { kind: "call", func: `<${n.name}>`, args: [], text: t };
  };
  return build(top);
}
