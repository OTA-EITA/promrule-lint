// The metric label table: which labels an exporter puts on each metric.
// The built-in table (metrics.json) only lists metrics whose labels were read
// from the exporter's source code; each entry links the file it came from.
import { readFile } from "node:fs/promises";
import builtin from "./metrics.json" with { type: "json" };
import type { MetricInfo } from "./labels.js";

const types = ["counter", "gauge", "untyped", "histogram", "summary"] as const;

export interface MetricFamily {
  /** Series names; for histograms and summaries the base name. */
  names: string[];
  type?: (typeof types)[number];
  labels: string[];
  /** Labels that are never empty. */
  always?: string[];
  source?: string | string[];
  note?: string;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validates a metric label file ({"families": [...]}) and returns its families. */
export function parseMetricFile(data: unknown): MetricFamily[] {
  const families = (data as { families?: unknown } | null)?.families;
  if (!Array.isArray(families)) throw new Error('expected an object with a "families" array');
  return families.map((f: unknown, i) => {
    const fam = (f ?? {}) as Record<string, unknown>;
    const where = `families[${String(i)}]`;
    if (!isStrings(fam.names) || fam.names.length === 0)
      throw new Error(`${where}.names must be a list of names`);
    if (!isStrings(fam.labels)) throw new Error(`${where}.labels must be a list of label names`);
    if (fam.always !== undefined && !isStrings(fam.always))
      throw new Error(`${where}.always must be a list of label names`);
    if (fam.type !== undefined && !types.includes(fam.type as MetricFamily["type"] & string))
      throw new Error(`${where}.type must be one of ${types.join(", ")}`);
    return fam as unknown as MetricFamily;
  });
}

/** Expands families into series names; later families replace earlier ones with the same name. */
export function metricTable(...sets: MetricFamily[][]): Map<string, MetricInfo> {
  const table = new Map<string, MetricInfo>();
  for (const families of sets) {
    for (const f of families) {
      const always = (f.always ?? []).filter((l) => f.labels.includes(l));
      for (const name of f.names) {
        if (f.type === "histogram") {
          table.set(`${name}_bucket`, { labels: [...f.labels, "le"], always: [...always, "le"] });
          table.set(`${name}_sum`, { labels: f.labels, always });
          table.set(`${name}_count`, { labels: f.labels, always });
        } else if (f.type === "summary") {
          table.set(name, { labels: [...f.labels, "quantile"], always: [...always, "quantile"] });
          table.set(`${name}_sum`, { labels: f.labels, always });
          table.set(`${name}_count`, { labels: f.labels, always });
        } else table.set(name, { labels: f.labels, always });
      }
    }
  }
  return table;
}

export const builtinFamilies: MetricFamily[] = parseMetricFile(builtin);

/** Reads a user metric label file and returns the built-in table with its families added. */
export async function loadMetricTable(file: string | undefined): Promise<Map<string, MetricInfo>> {
  if (file === undefined) return metricTable(builtinFamilies);
  let families: MetricFamily[];
  try {
    families = parseMetricFile(JSON.parse(await readFile(file, "utf8")));
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`, { cause: err });
  }
  return metricTable(builtinFamilies, families);
}
