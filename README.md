# promrule-lint

[![ci](https://github.com/OTA-EITA/promrule-lint/actions/workflows/ci.yml/badge.svg)](https://github.com/OTA-EITA/promrule-lint/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/OTA-EITA/promrule-lint/badge)](https://securityscorecards.dev/viewer/?uri=github.com/OTA-EITA/promrule-lint)

**Find the Prometheus alerts that will page you at 3 a.m. for nothing — or never page you at all.**

`promtool check rules` tells you whether a rule file is valid. promrule-lint tells you whether the rules will behave: alerts that fire on a single bad scrape, `rate()` windows too short to ever return a value, aggregations that hide counter resets, `by (node)` on a metric that has no `node` label, comparisons whose two sides never match, and alerts that reach the on-call engineer without a runbook.

```text
$ npx github:OTA-EITA/promrule-lint test/fixtures/bad
test/fixtures/bad/rules.yml:4  HIGH   PR006  rate(...[30s]) in HighErrorRate covers fewer than 2 scrape intervals of 1m
test/fixtures/bad/rules.yml:16  HIGH   PR008  RequestsDropped applies rate() to sum(), so counter resets are not detected
test/fixtures/bad/rules.yml:4  MEDIUM PR001  HighErrorRate has no for, so it fires on a single evaluation
test/fixtures/bad/rules.yml:8  MEDIUM PR007  CpuSpike uses irate(), which Prometheus documents for graphs, not alerts
test/fixtures/bad/rules.yml:22  MEDIUM PR010  CpuSpike duplicates the alert on line 8 with the same labels
test/fixtures/bad/rules.yml:4  LOW    PR004  HighErrorRate has no runbook_url annotation
…
1 file(s), 16 finding(s): 4 high, 5 medium, 7 low
```

Works on plain Prometheus rule files and on Kubernetes `PrometheusRule` resources (prometheus-operator, kube-prometheus-stack), including multi-document YAML. Directories are searched for rule files; workflows and other manifests are skipped.

## Tested on real rule sets

| Rule set                                                                                                                                                                 | Rules                          | Findings                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [kube-prometheus](https://github.com/prometheus-operator/kube-prometheus) `manifests/*prometheusRule.yaml` (b6c2f62), `--scrape-interval 30s --target-labels kubernetes` | 139 alerts, 96 recording rules | 10 alerts without `for`, 2 with severity `none`, 1 without a summary, and two label bugs: `node:node_cpu_utilization:ratio_rate5m` groups by a `node` label that `node_cpu_seconds_total` never has (PR012), and `PrometheusNotificationQueueRunningFull` compares two series that never match, so it can never fire (PR013) |
| [awesome-prometheus-alerts](https://github.com/samber/awesome-prometheus-alerts) `dist/rules` (736370e), default 1m scrape interval                                      | 1,162 alerts in 112 files      | 255 alerts with `for: 0m`, 98 alerts whose `[1m]` range is too short for a 1m scrape interval, none of the 1,162 has a `runbook_url`, and `KubernetesCronjobTooLong` can never fire: `kube_job_status_start_time > 0 and absent(...)` never matches, because `absent()` returns a series without labels (PR013)              |

Both kube-prometheus label bugs come from upstream mixins and are tracked there: the missing `node` label in [kubernetes-sigs/kubernetes-mixin#1326](https://github.com/kubernetes-sigs/kubernetes-mixin/pull/1326), the alert that cannot fire in [prometheus/prometheus#20051](https://github.com/prometheus/prometheus/issues/20051).

Every rule was tuned against these: for example, `Watchdog`-style heartbeat alerts (`vector(1)`) are not asked for a `for`, kubernetes-mixin's `:metric:sum` recording rule names are accepted, and joins such as `* on (cluster, namespace, pod) group_left (node) topk by (cluster, namespace, pod) (1, node_namespace_pod:kube_pod_info:)` are followed through the recording rule they use.

## Checks

| ID    | Severity | What it catches                                                                                                                                                                     |
| ----- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR001 | medium   | Alert without `for` (or `for: 0`): one bad scrape pages someone and the alert flaps                                                                                                 |
| PR002 | medium   | Alert without a `severity` label, so routing cannot tell a page from a ticket                                                                                                       |
| PR003 | low      | Severity not in the allowed list (default `critical`, `warning`, `info`)                                                                                                            |
| PR004 | low      | No `runbook_url` annotation, or not an http(s) URL                                                                                                                                  |
| PR005 | low      | Neither `summary` nor `description`                                                                                                                                                 |
| PR006 | high     | `rate`/`increase`/`delta`/`irate`/`idelta`/`deriv` range shorter than N scrape intervals: with fewer than two samples Prometheus returns nothing, so the alert silently never fires |
| PR007 | medium   | `irate()` in an alert                                                                                                                                                               |
| PR008 | high     | Aggregation before `rate()`/`increase()`, e.g. `rate(sum(x)[5m:])`, which hides counter resets                                                                                      |
| PR009 | low      | Recording rule name without the `level:metric:operations` colons                                                                                                                    |
| PR010 | medium   | Two alerts in a group with the same name and labels                                                                                                                                 |
| PR011 | high     | Malformed rule or file: missing `expr`, both `alert` and `record`, invalid `for`                                                                                                    |
| PR012 | high     | `by (x)`, `on (x)` or `group_left (x)` where label `x` is never on the input: the "per x" result is one series without `x`                                                          |
| PR013 | high     | A binary operation whose two sides can never have the same labels (e.g. one side always has `alertmanager`, the other never does), so the result is always empty                    |

Where the checks come from, in Prometheus's own words:

- `irate`: _"Use `rate` for alerts and slow-moving counters, as brief changes in the rate can reset the `FOR` clause"_ ([functions](https://prometheus.io/docs/prometheus/latest/querying/functions/#irate))
- `rate` with aggregation: _"always take a `rate()` first, then aggregate. Otherwise `rate()` cannot detect counter resets"_ ([functions](https://prometheus.io/docs/prometheus/latest/querying/functions/#rate))
- Short ranges: `deriv`, `irate` and `idelta` need two samples per the docs; for `rate`/`increase`/`delta`, `extrapolatedRate` in [`promql/functions.go`](https://github.com/prometheus/prometheus/blob/main/promql/functions.go) returns nothing for a single sample
- Naming: _"Recording rules should be of the general form `level:metric:operations`"_ ([rules practices](https://prometheus.io/docs/practices/rules/))
- Matching: _"Two entries match if they have the exact same set of labels and corresponding values"_; without `group_left`/`group_right`, entries with no match are dropped ([operators](https://prometheus.io/docs/prometheus/latest/querying/operators/#vector-matching))

### How the label checks know the labels

PR012 and PR013 parse each expression with the official PromQL grammar ([`@prometheus-io/lezer-promql`](https://www.npmjs.com/package/@prometheus-io/lezer-promql)) and work out which labels every part of it can carry: aggregations keep their `by` labels or drop their `without` labels, joins add their `group_left` labels, `label_replace` adds its target label, `histogram_quantile` drops `le`, `vector()` and `absent()` have no labels beyond their matchers, and recording rules from every scanned file are resolved recursively.

The labels of a raw metric come from a [built-in table](src/metrics.json) of node_exporter, kube-state-metrics, Prometheus, Alertmanager and prometheus-operator metrics. Each entry was read from the exporter's source code and links the file and commit it came from. A metric that is not in the table has unknown labels, and nothing that depends on it is ever reported: a missed bug is better than a false alarm.

On top of the exporter's labels, the scrape adds target labels. The default is `job` and `instance`. With prometheus-operator or kube-prometheus, use `--target-labels kubernetes`, which adds `namespace`, `service`, `endpoint`, `pod` and `container` (what prometheus-operator sets for pod-backed targets) and `cluster` (which kubernetes-mixin groups by so the same rules work across clusters). Add any label your relabeling or external labels set, e.g. `--target-labels kubernetes,region`.

Your own metrics can be described in a JSON file passed with `--metrics-labels`; entries replace built-in ones with the same name:

```json
{
  "families": [
    { "names": ["http_requests_total"], "labels": ["code", "method"], "always": ["code", "method"] },
    { "names": ["http_request_duration_seconds"], "type": "histogram", "labels": ["method"] }
  ]
}
```

`always` lists labels that are never empty; PR013 only reports a mismatch when one side always has a label that the other side never has. A `histogram` expands to `_bucket` (with `le`), `_sum` and `_count`, a `summary` to the series with `quantile` plus `_sum` and `_count`.

## Usage

```sh
npx github:OTA-EITA/promrule-lint [options] [path ...]
```

| Option                | Default                 |                                                                                                                            |
| --------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--scrape-interval`   | `1m`                    | Scrape interval your rules run against (Prometheus's default is 1m; kube-prometheus scrapes most targets every 15s or 30s) |
| `--min-window-factor` | `2`                     | A range must cover this many scrape intervals. 2 is the hard minimum; many teams use 4 to survive a missed scrape          |
| `--severities`        | `critical,warning,info` | Allowed `severity` values                                                                                                  |
| `--target-labels`     | `job,instance`          | Labels the scrape adds to every series; `kubernetes` adds the prometheus-operator labels and `cluster`                     |
| `--metrics-labels`    |                         | JSON file with the labels of more metrics, added to the built-in table                                                     |
| `--format`            | `text`                  | `text`, `json`, `markdown` or `sarif`                                                                                      |
| `--fail-on`           | `medium`                | Exit 1 on findings at least this severe (`high`, `medium`, `low`, `none`)                                                  |
| `--list-checks`       |                         | Print the checks                                                                                                           |

### Ignoring a finding on purpose

Put a comment above the rule (or on its first line), with the reason:

```yaml
rules:
  # Certificate expiry is a level, not a spike. promrule-lint-ignore PR001
  - alert: KubeletServerCertificateExpiration
    expr: kubelet_certificate_manager_server_ttl_seconds < 604800
```

`promrule-lint-ignore all` disables every check for that rule.

### GitHub Actions

```yaml
permissions:
  contents: read
  security-events: write
steps:
  - uses: actions/checkout@v5
    with:
      persist-credentials: false
  - uses: OTA-EITA/promrule-lint@v0.2.0 # pin to a commit SHA in real use
    id: lint
    with:
      path: deploy/monitoring
      scrape-interval: 30s
      target-labels: kubernetes
      fail-on: high
  - uses: github/codeql-action/upload-sarif@v4
    if: always()
    with:
      sarif_file: ${{ steps.lint.outputs.sarif-file }}
      category: promrule-lint
```

Findings show up as pull request annotations, in the job summary and in code scanning.

## Development

```sh
npm ci --ignore-scripts
npm run coverage
npm run lint
npm run build   # commit dist/ after changing src/
```

To add a metric to the built-in table, read the code that sets its labels and add an entry to `src/metrics.json` with a `source` link pinned to that commit.

Dependencies are locked to versions published at least 7 days ago and checked in CI with [lockfile-guard](https://github.com/OTA-EITA/lockfile-guard); workflows are pinned and checked with [gha-guard](https://github.com/OTA-EITA/gha-guard).

## Related

- [alert-router](https://github.com/OTA-EITA/alert-router): routes Alertmanager notifications to Slack with deduplication and runbook links
- [slo-report](https://github.com/OTA-EITA/slo-report): generates multi-window burn-rate alerts from SLO definitions

## License

MIT
