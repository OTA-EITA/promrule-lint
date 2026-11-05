import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntryPoint, main } from "../src/cli.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fx = (p: string) => path.join(root, "test/fixtures", p);

async function run(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), cwd: root });
  return { code, stdout, stderr };
}

describe("main", () => {
  it("fails on the bad fixture with relative paths", async () => {
    const r = await run([fx("bad")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("test/fixtures/bad/rules.yml:4  HIGH   PR006");
    expect(r.stdout).toContain("1 file(s), 16 finding(s): 4 high, 5 medium, 7 low");
  });

  it("passes the good fixture with custom severities", async () => {
    expect((await run(["--severities", "critical, none", fx("good")])).code).toBe(0);
  });

  it("skips non-rule YAML in directories", async () => {
    const r = await run(["--severities", "critical,none", fx("mixed")]);
    expect(r.stdout).toContain("1 file(s), 0 finding(s)");
  });

  it("scrape interval and factor change PR006", async () => {
    const r = await run(["--format", "json", "--scrape-interval", "10s", "--fail-on", "none", fx("bad")]);
    const ids = (JSON.parse(r.stdout) as { findings: { ruleId: string }[] }).findings.map((f) => f.ruleId);
    expect(ids).not.toContain("PR006");
    const strict = await run([
      "--format",
      "json",
      "--min-window-factor",
      "40",
      "--fail-on",
      "none",
      fx("good"),
    ]);
    expect(strict.stdout).toContain("PR006");
  });

  it("--fail-on decides the exit code", async () => {
    expect((await run(["--fail-on", "none", fx("bad")])).code).toBe(0);
    expect((await run(["--fail-on", "high", fx("operator")])).code).toBe(0);
  });

  it("renders markdown and sarif", async () => {
    expect((await run(["--format", "markdown", "--fail-on", "none", fx("bad")])).stdout).toContain(
      "| Severity | Check | Rule | Problem | What to do |",
    );
    const sarif = JSON.parse((await run(["--format", "sarif", "--fail-on", "none", fx("bad")])).stdout) as {
      runs: { tool: { driver: { name: string; rules: unknown[] } }; results: unknown[] }[];
    };
    expect(sarif.runs[0]?.tool.driver.name).toBe("promrule-lint");
    expect(sarif.runs[0]?.tool.driver.rules).toHaveLength(13);
    expect(sarif.runs[0]?.results).toHaveLength(16);
  });

  it("--target-labels and --metrics-labels feed the label checks", async () => {
    const k8s = await run(["--target-labels", "kubernetes", fx("labels")]);
    expect(k8s.code).toBe(1);
    expect(k8s.stdout).toContain("test/fixtures/labels/bugs.yml:8  HIGH   PR012");
    expect(k8s.stdout).toContain("test/fixtures/labels/bugs.yml:20  HIGH   PR013");
    expect(k8s.stdout).toContain("2 file(s), 2 finding(s): 2 high, 0 medium, 0 low");

    const file = path.join(mkdtempSync(path.join(tmpdir(), "prl-")), "metrics.json");
    writeFileSync(file, JSON.stringify({ families: [{ names: ["my_team_info"], labels: ["tenant"] }] }));
    const custom = await run([
      "--target-labels",
      "kubernetes",
      "--metrics-labels",
      file,
      fx("labels/fine.yml"),
    ]);
    expect(custom.stdout).toContain("fine.yml:76  HIGH   PR012  CustomMetric:");
    expect(custom.stdout).toContain("copies team from a side that never has it");
  });

  it("prints help, version and checks", async () => {
    expect((await run(["-h"])).stdout).toContain("usage: promrule-lint");
    expect((await run(["--version"])).stdout).toBe("promrule-lint dev\n");
    expect((await run(["--list-checks"])).stdout.trim().split("\n")).toHaveLength(13);
  });

  it.each([
    [["--bogus"], /Unknown option/],
    [["--format", "xml"], /unknown format/],
    [["--fail-on", "critical"], /--fail-on must be/],
    [["--scrape-interval", "fast"], /--scrape-interval must be/],
    [["--scrape-interval", "0"], /--scrape-interval must be/],
    [["--min-window-factor", "0.5"], /--min-window-factor must be/],
    [["/does/not/exist"], /ENOENT/],
    [[path.join(root, "src")], /no Prometheus rule files found/],
    [["--metrics-labels", path.join(root, "package.json"), fx("good")], /package\.json: expected an object/],
  ])("rejects %j", async (args, msg) => {
    const r = await run(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(msg);
  });
});

describe("isEntryPoint", () => {
  const self = new URL("../src/cli.ts", import.meta.url).href;
  it("follows symlinks and rejects other files", () => {
    const file = fileURLToPath(self);
    const link = path.join(mkdtempSync(path.join(tmpdir(), "prl-")), "promrule-lint");
    symlinkSync(file, link);
    expect(isEntryPoint(link, self)).toBe(true);
    expect(isEntryPoint(undefined, self)).toBe(false);
    expect(isEntryPoint("/no/such/file", self)).toBe(false);
  });
});
