import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { lint } from "./checks.js";
import type { Options } from "./checks.js";
import { parseRuleFile } from "./parse.js";
import type { Finding } from "./types.js";

const skipDirs = new Set(["node_modules", ".git", "dist", "vendor"]);
const looksLikeRules = /^\s*groups:|kind:\s*PrometheusRule/m;
const hasRule = /^\s*-?\s*(alert|record):/m;

/**
 * Finds rule files. A file path is always used; inside a directory only YAML
 * files that look like rule files are, so workflows and other manifests are skipped.
 */
export async function findRuleFiles(root: string): Promise<string[]> {
  if ((await stat(root)).isFile()) return [root];
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) await walk(p);
      } else if (/\.ya?ml$/.test(e.name)) {
        const src = await readFile(p, "utf8");
        if (looksLikeRules.test(src) && hasRule.test(src)) out.push(p);
      }
    }
  };
  await walk(root);
  return out;
}

export interface ScanResult {
  findings: Finding[];
  files: number;
  rules: number;
}

export async function scan(paths: string[], cwd: string, opt: Options): Promise<ScanResult> {
  const result: ScanResult = { findings: [], files: 0, rules: 0 };
  for (const p of paths) {
    for (const file of await findRuleFiles(p)) {
      const rel = path.relative(cwd, file).split(path.sep).join("/") || file;
      const parsed = parseRuleFile(rel, await readFile(file, "utf8"));
      result.files++;
      result.rules += parsed.rules.length;
      result.findings.push(...lint(parsed, opt));
    }
  }
  return result;
}
