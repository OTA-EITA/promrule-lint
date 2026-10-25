// GitHub Action entry point. Inputs arrive as INPUT_* environment variables;
// outputs, annotations and the job summary use the files GitHub provides.
import { appendFileSync, writeFileSync } from "node:fs";
import { checks, defaultOptions } from "./checks.js";
import { parseDuration } from "./duration.js";
import { render } from "./report.js";
import { scan } from "./scan.js";
import { severityRank } from "./types.js";
import type { Severity } from "./types.js";

declare const __VERSION__: string | undefined;
const version = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

function input(name: string, fallback: string): string {
  const v = process.env[`INPUT_${name.toUpperCase()}`];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

// https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escapeData = (s: string) => s.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (s: string) => escapeData(s).replaceAll(":", "%3A").replaceAll(",", "%2C");

async function run(): Promise<void> {
  const failOn = input("fail-on", "high");
  // A typo must not turn the gate off silently.
  if (failOn !== "none" && !(failOn in severityRank)) {
    throw new Error(`fail-on must be high, medium, low or none, got "${failOn}"`);
  }
  const scrape = parseDuration(input("scrape-interval", "1m"));
  if (!scrape) throw new Error("scrape-interval must be a duration such as 30s or 1m");
  const factor = Number(input("min-window-factor", String(defaultOptions.minWindowFactor)));
  if (!Number.isFinite(factor) || factor < 1)
    throw new Error("min-window-factor must be a number of at least 1");
  const severities = input("severities", defaultOptions.severities.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sarifFile = input("sarif-file", "promrule-lint.sarif");

  const result = await scan(input("path", ".").split(/\s+/), process.cwd(), {
    scrapeIntervalMs: scrape,
    minWindowFactor: factor,
    severities,
  });
  if (result.files === 0) throw new Error("no Prometheus rule files found");

  const opts = { files: result.files, rules: checks, version };
  writeFileSync(sarifFile, render(result.findings, "sarif", opts));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, render(result.findings, "markdown", opts));
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `sarif-file=${sarifFile}\nfindings=${String(result.findings.length)}\n`);
  for (const f of result.findings) {
    const level = f.severity === "high" ? "error" : f.severity === "medium" ? "warning" : "notice";
    process.stdout.write(
      `::${level} file=${escapeProperty(f.file)},line=${String(f.line)},title=${f.ruleId}::${escapeData(f.message)}\n`,
    );
  }
  if (
    failOn !== "none" &&
    result.findings.some((f) => severityRank[f.severity] >= severityRank[failOn as Severity])
  ) {
    process.exitCode = 1;
  }
}

run().catch((err: unknown) => {
  process.stdout.write(`::error::${escapeData(String(err))}\n`);
  process.exitCode = 1;
});
