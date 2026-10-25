// Just enough PromQL scanning for the checks: function calls, their range
// selectors, and what sits directly inside them. Not a full parser.

/** Replaces string literals with spaces (keeping offsets) so brackets inside label values are ignored. */
export function maskStrings(expr: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr.charAt(i);
    if (quote) {
      if (ch === "\\" && quote !== "`") {
        out += "  ";
        i++;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
        out += ch;
      } else out += " ";
    } else {
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      out += ch;
    }
  }
  return out;
}

export interface Call {
  name: string;
  /** Argument text between the parentheses, with strings masked. */
  args: string;
}

const keywords = new Set([
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "and",
  "or",
  "unless",
]);

/** Every function or aggregation call in the expression, outermost first. */
export function calls(expr: string): Call[] {
  const s = maskStrings(expr);
  const out: Call[] = [];
  const re = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const name = m[1] ?? "";
    if (keywords.has(name)) continue;
    const open = m.index + m[0].length;
    let depth = 1;
    let i = open;
    for (; i < s.length && depth > 0; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
    }
    out.push({ name, args: s.slice(open, depth === 0 ? i - 1 : s.length) });
  }
  return out;
}

/** Range durations written in the call's own arguments, e.g. "5m" in rate(x[5m]) or rate(x[5m:1m]). */
export function rangeWindows(args: string): string[] {
  // Only the top level of the arguments: a range inside a nested call belongs to that call.
  let depth = 0;
  let top = "";
  for (const ch of args) {
    if (ch === "(") depth++;
    if (depth === 0) top += ch;
    if (ch === ")") depth--;
  }
  return [...top.matchAll(/\[\s*([0-9][0-9a-z]*)\s*(?::[^\]]*)?\]/g)].map((m) => m[1] ?? "");
}

const aggregations = new Set([
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "group",
  "stddev",
  "stdvar",
  "topk",
  "bottomk",
  "quantile",
  "count_values",
  "limitk",
  "limit_ratio",
]);

/** The aggregation applied directly to the call's input, e.g. "sum" for rate(sum(x)[5m:]). */
export function aggregatedInput(args: string): string | undefined {
  const m = /^\s*([a-z_]+)\s*(?:\(|by\b|without\b)/.exec(args);
  return m?.[1] && aggregations.has(m[1]) ? m[1] : undefined;
}
