import { formatDuration, parseDuration } from "./duration.js";
import type { Rule, RuleFile } from "./parse.js";
import { aggregatedInput, calls, rangeWindows } from "./promql.js";
import type { Check, Finding } from "./types.js";
import { severityRank } from "./types.js";

export const checks: Check[] = [
  {
    id: "PR001",
    severity: "medium",
    title: "Alert without for",
    description:
      "The alert fires on a single evaluation, so one bad scrape pages someone and the alert flaps.",
  },
  {
    id: "PR002",
    severity: "medium",
    title: "Missing severity label",
    description:
      "Alertmanager routes and notification tools usually decide who is paged from the severity label.",
  },
  {
    id: "PR003",
    severity: "low",
    title: "Unknown severity",
    description: "The severity is not one of the allowed values, so routing may not match it.",
  },
  {
    id: "PR004",
    severity: "low",
    title: "Missing runbook",
    description:
      "No runbook_url annotation, or it is not an http(s) URL, so the person paged has nowhere to start.",
  },
  {
    id: "PR005",
    severity: "low",
    title: "Missing summary",
    description:
      "Neither a summary nor a description annotation, so the notification says little more than the name.",
  },
  {
    id: "PR006",
    severity: "high",
    title: "Range too short for the scrape interval",
    description:
      "rate(), increase() and similar functions need at least two samples in the range; a range shorter than a few scrape intervals returns nothing and the alert never fires.",
  },
  {
    id: "PR007",
    severity: "medium",
    title: "irate() in an alert",
    description:
      "Prometheus documents irate() for graphing volatile counters only; in alerts brief changes reset the for clause.",
  },
  {
    id: "PR008",
    severity: "high",
    title: "Aggregation before rate()",
    description:
      "Aggregating before rate() hides counter resets, so restarts show up as huge spikes or drops.",
  },
  {
    id: "PR009",
    severity: "low",
    title: "Recording rule name",
    description: "Recording rules should be named level:metric:operations.",
  },
  {
    id: "PR010",
    severity: "medium",
    title: "Duplicate alert",
    description:
      "Two alerts in the same group share a name and labels, so their notifications are indistinguishable.",
  },
  {
    id: "PR011",
    severity: "high",
    title: "Invalid rule",
    description: "The rule or file is malformed: Prometheus would refuse to load it.",
  },
];

export interface Options {
  /** Scrape interval the rules are evaluated against. */
  scrapeIntervalMs: number;
  /** A range must cover at least this many scrape intervals. */
  minWindowFactor: number;
  /** Allowed values of the severity label. */
  severities: string[];
}

export const defaultOptions: Options = {
  scrapeIntervalMs: 60_000,
  minWindowFactor: 2,
  severities: ["critical", "warning", "info"],
};

// Functions that return nothing with fewer than two samples in the range: irate, idelta
// and deriv per the Prometheus docs, rate/increase/delta per promql/functions.go
// (extrapolatedRate: "There's a single sample ... Return nothing").
const counterFunctions = new Set(["rate", "irate", "increase", "delta", "idelta", "deriv"]);
const resetSensitive = new Set(["rate", "irate", "increase", "resets"]);

function finding(file: RuleFile, rule: Rule, f: Omit<Finding, "file" | "line" | "target">): Finding {
  return { ...f, file: file.file, line: rule.line, target: rule.name || rule.group };
}

function checkRule(file: RuleFile, rule: Rule, opt: Options): Finding[] {
  const out: Finding[] = [];
  const add = (f: Omit<Finding, "file" | "line" | "target">) => {
    if (!rule.ignore.includes(f.ruleId) && !rule.ignore.includes("ALL")) out.push(finding(file, rule, f));
  };

  for (const e of rule.errors) {
    add({ ruleId: "PR011", severity: "high", message: `rule in group "${rule.group}" ${e}` });
  }
  if (rule.errors.length) return out;

  if (rule.kind === "alert") {
    const forMs = rule.for === undefined ? 0 : parseDuration(rule.for);
    if (forMs === undefined) {
      add({
        ruleId: "PR011",
        severity: "high",
        message: `${rule.name}: for "${rule.for ?? ""}" is not a duration`,
      });
    } else if (forMs === 0 && !/^\s*vector\(\s*[\d.]+\s*\)\s*$/.test(rule.expr)) {
      // A constant expression (e.g. a Watchdog heartbeat) is always firing by design.
      add({
        ruleId: "PR001",
        severity: "medium",
        message: `${rule.name} has no for, so it fires on a single evaluation`,
        help: "Add for: with at least a few evaluation intervals (e.g. 5m) so a single bad scrape does not page.",
      });
    }

    const severity = rule.labels.severity;
    if (severity === undefined) {
      add({
        ruleId: "PR002",
        severity: "medium",
        message: `${rule.name} has no severity label`,
        help: `Add labels.severity (${opt.severities.join(", ")}) so routing can tell a page from a ticket.`,
      });
    } else if (!opt.severities.includes(severity)) {
      add({
        ruleId: "PR003",
        severity: "low",
        message: `${rule.name} has severity "${severity}", which is not one of ${opt.severities.join(", ")}`,
      });
    }

    const runbook = rule.annotations.runbook_url;
    if (runbook === undefined || !/^https?:\/\/\S+$/.test(runbook)) {
      add({
        ruleId: "PR004",
        severity: "low",
        message:
          runbook === undefined
            ? `${rule.name} has no runbook_url annotation`
            : `${rule.name} has a runbook_url that is not an http(s) URL: ${runbook}`,
        help: "Link the page that tells the on-call engineer what to check first.",
      });
    }

    if (rule.annotations.summary === undefined && rule.annotations.description === undefined) {
      add({
        ruleId: "PR005",
        severity: "low",
        message: `${rule.name} has neither a summary nor a description annotation`,
        help: "Describe the impact and the affected target with {{ $labels.* }} so the notification stands on its own.",
      });
    }
  } else if (!rule.name.includes(":")) {
    // Empty parts are common on purpose (kubernetes-mixin uses ":metric:sum" and "level:metric:"), so only a missing colon is flagged.
    add({
      ruleId: "PR009",
      severity: "low",
      message: `recording rule ${rule.name} does not follow level:metric:operations`,
      help: "For example job:http_requests:rate5m.",
    });
  }

  const minWindow = opt.scrapeIntervalMs * opt.minWindowFactor;
  for (const call of calls(rule.expr)) {
    if (counterFunctions.has(call.name)) {
      for (const w of rangeWindows(call.args)) {
        const ms = parseDuration(w);
        if (ms !== undefined && ms < minWindow) {
          add({
            ruleId: "PR006",
            severity: "high",
            message: `${call.name}(...[${w}]) in ${rule.name || rule.group} covers fewer than ${String(opt.minWindowFactor)} scrape intervals of ${formatDuration(opt.scrapeIntervalMs)}`,
            help: `Use a range of at least ${formatDuration(minWindow)}; with fewer than two samples in the range the result is empty and the rule silently never matches.`,
          });
        }
      }
    }
    if (call.name === "irate" && rule.kind === "alert") {
      add({
        ruleId: "PR007",
        severity: "medium",
        message: `${rule.name} uses irate(), which Prometheus documents for graphs, not alerts`,
        help: "Use rate(); brief changes in irate() reset the for clause.",
      });
    }
    const agg = resetSensitive.has(call.name) ? aggregatedInput(call.args) : undefined;
    if (agg) {
      add({
        ruleId: "PR008",
        severity: "high",
        message: `${rule.name || rule.group} applies ${call.name}() to ${agg}(), so counter resets are not detected`,
        help: `Take ${call.name}() first, then aggregate: ${agg}(${call.name}(metric[5m])).`,
      });
    }
  }
  return out;
}

export function lint(file: RuleFile, opt: Options = defaultOptions): Finding[] {
  const findings: Finding[] = file.errors.map((e) => ({
    ruleId: "PR011",
    severity: "high" as const,
    target: file.file,
    file: file.file,
    line: e.line,
    message: `invalid rule file: ${e.message}`,
  }));

  const seen = new Map<string, Rule>();
  for (const rule of file.rules) {
    findings.push(...checkRule(file, rule, opt));
    if (rule.kind !== "alert" || rule.errors.length) continue;
    const key = `${rule.group}\u0000${rule.name}\u0000${JSON.stringify(Object.entries(rule.labels).sort())}`;
    const first = seen.get(key);
    if (first) {
      findings.push(
        finding(file, rule, {
          ruleId: "PR010",
          severity: "medium",
          message: `${rule.name} duplicates the alert on line ${String(first.line)} with the same labels`,
          help: "Give each variant a distinguishing label (e.g. severity) or merge the expressions.",
        }),
      );
    } else seen.set(key, rule);
  }

  return findings.sort(
    (a, b) =>
      severityRank[b.severity] - severityRank[a.severity] ||
      a.line - b.line ||
      a.ruleId.localeCompare(b.ruleId),
  );
}
