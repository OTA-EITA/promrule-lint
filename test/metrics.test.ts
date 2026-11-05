import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import builtin from "../src/metrics.json" with { type: "json" };
import { builtinFamilies, loadMetricTable, metricTable, parseMetricFile } from "../src/metrics.js";

describe("parseMetricFile", () => {
  it.each([
    [null, /"families" array/],
    [{ families: [{ labels: [] }] }, /families\[0\]\.names/],
    [{ families: [{ names: ["a"], labels: "x" }] }, /families\[0\]\.labels/],
    [{ families: [{ names: ["a"], labels: [], always: [1] }] }, /families\[0\]\.always/],
    [{ families: [{ names: ["a"], labels: [], type: "timer" }] }, /families\[0\]\.type/],
  ])("rejects %j", (data, msg) => {
    expect(() => parseMetricFile(data)).toThrow(msg);
  });
});

describe("metricTable", () => {
  it("expands histograms and summaries, and later sets win", () => {
    const t = metricTable(
      [
        { names: ["req_seconds"], type: "histogram", labels: ["code"], always: ["code", "stray"] },
        { names: ["rpc_seconds"], type: "summary", labels: [] },
        { names: ["up_total"], labels: ["a"] },
      ],
      [{ names: ["up_total"], labels: ["b"] }],
    );
    expect(Object.fromEntries(t)).toEqual({
      req_seconds_bucket: { labels: ["code", "le"], always: ["code", "le"] },
      req_seconds_sum: { labels: ["code"], always: ["code"] },
      req_seconds_count: { labels: ["code"], always: ["code"] },
      rpc_seconds: { labels: ["quantile"], always: ["quantile"] },
      rpc_seconds_sum: { labels: [], always: [] },
      rpc_seconds_count: { labels: [], always: [] },
      up_total: { labels: ["b"], always: [] },
    });
  });
});

describe("built-in table", () => {
  it("links every family to the source file at a fixed commit", () => {
    expect(builtin.families.length).toBe(builtinFamilies.length);
    for (const f of builtinFamilies) {
      const sources = Array.isArray(f.source) ? f.source : [f.source ?? ""];
      for (const s of sources)
        expect(s).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[0-9a-f]{40}\//);
      expect(f.labels).toEqual(expect.arrayContaining(f.always ?? []));
    }
  });

  it("lists each metric once", () => {
    const names = builtinFamilies.flatMap((f) => f.names);
    expect(new Set(names).size).toBe(names.length);
    expect(metricTable(builtinFamilies).get("node_cpu_seconds_total")).toEqual({
      labels: ["cpu", "mode"],
      always: ["cpu", "mode"],
    });
  });
});

describe("loadMetricTable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "prl-metrics-"));

  it("adds a user file to the built-in table", async () => {
    const file = path.join(dir, "ok.json");
    writeFileSync(file, JSON.stringify({ families: [{ names: ["my_metric"], labels: ["tenant"] }] }));
    const t = await loadMetricTable(file);
    expect(t.get("my_metric")).toEqual({ labels: ["tenant"], always: [] });
    expect(t.has("node_cpu_seconds_total")).toBe(true);
    expect((await loadMetricTable(undefined)).has("my_metric")).toBe(false);
  });

  it("names the file in errors", async () => {
    const file = path.join(dir, "bad.json");
    writeFileSync(file, "{");
    await expect(loadMetricTable(file)).rejects.toThrow(/bad\.json: /);
  });
});
