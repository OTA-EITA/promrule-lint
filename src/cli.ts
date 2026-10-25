import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checks, defaultOptions } from "./checks.js";
import { formatDuration, parseDuration } from "./duration.js";
import { formats, render } from "./report.js";
import type { Format } from "./report.js";
import { scan } from "./scan.js";
import { severityRank } from "./types.js";
import type { Severity } from "./types.js";

declare const __VERSION__: string | undefined;
const version = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const usage = `usage: promrule-lint [options] [path ...]

Lints Prometheus alerting and recording rules. Paths default to the current
directory; directories are searched for rule files (including PrometheusRule).

options:
  --scrape-interval <d>     scrape interval the rules run against (default: ${formatDuration(defaultOptions.scrapeIntervalMs)})
  --min-window-factor <n>   a range must cover this many scrape intervals (default: ${String(defaultOptions.minWindowFactor)})
  --severities <list>       allowed severity values, comma separated (default: ${defaultOptions.severities.join(",")})
  --format <format>         text, json, markdown or sarif (default: text)
  --fail-on <severity>      exit 1 on findings at least this severe: high, medium, low or none (default: medium)
  --list-checks             print the checks and exit
  --version                 print the version and exit
  -h, --help                show this help
`;

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
}

export async function main(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "scrape-interval": { type: "string" },
        "min-window-factor": { type: "string" },
        severities: { type: "string" },
        format: { type: "string", default: "text" },
        "fail-on": { type: "string", default: "medium" },
        "list-checks": { type: "boolean", default: false },
        version: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    io.stderr(`error: ${(err as Error).message}\n\n${usage}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(usage);
    return 0;
  }
  if (values.version) {
    io.stdout(`promrule-lint ${version}\n`);
    return 0;
  }
  if (values["list-checks"]) {
    io.stdout(
      checks.map((c) => `${c.id}  ${c.severity.padEnd(6)}  ${c.title}: ${c.description}`).join("\n") + "\n",
    );
    return 0;
  }
  if (!(formats as string[]).includes(values.format)) {
    io.stderr(`error: unknown format "${values.format}" (want ${formats.join(", ")})\n`);
    return 2;
  }
  const failOn = values["fail-on"];
  if (failOn !== "none" && !(failOn in severityRank)) {
    io.stderr(`error: --fail-on must be high, medium, low or none, got "${failOn}"\n`);
    return 2;
  }
  const opt = { ...defaultOptions };
  if (values["scrape-interval"] !== undefined) {
    const ms = parseDuration(values["scrape-interval"]);
    if (!ms) {
      io.stderr(`error: --scrape-interval must be a duration such as 30s or 1m\n`);
      return 2;
    }
    opt.scrapeIntervalMs = ms;
  }
  if (values["min-window-factor"] !== undefined) {
    const n = Number(values["min-window-factor"]);
    if (!Number.isFinite(n) || n < 1) {
      io.stderr(`error: --min-window-factor must be a number of at least 1\n`);
      return 2;
    }
    opt.minWindowFactor = n;
  }
  if (values.severities !== undefined) {
    opt.severities = values.severities
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  let result;
  try {
    result = await scan(positionals.length ? positionals : ["."], io.cwd, opt);
  } catch (err) {
    io.stderr(`error: ${(err as Error).message}\n`);
    return 2;
  }
  if (result.files === 0) {
    io.stderr("error: no Prometheus rule files found\n");
    return 2;
  }
  io.stdout(
    render(result.findings, values.format as Format, { files: result.files, rules: checks, version }),
  );
  if (failOn === "none") return 0;
  const threshold = severityRank[failOn as Severity];
  return result.findings.some((f) => severityRank[f.severity] >= threshold) ? 1 : 0;
}

/** True when this module is the program being run, also through npm's bin symlink. */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Exercised by the packaged-binary check in CI rather than unit tests.
/* v8 ignore start */
if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    cwd: process.cwd(),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`error: ${String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
/* v8 ignore stop */
