# promrule-lint

[![ci](https://github.com/OTA-EITA/promrule-lint/actions/workflows/ci.yml/badge.svg)](https://github.com/OTA-EITA/promrule-lint/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/OTA-EITA/promrule-lint/badge)](https://securityscorecards.dev/viewer/?uri=github.com/OTA-EITA/promrule-lint)

**Find the Prometheus alerts that will page you at 3 a.m. for nothing — or never page you at all.**

`promtool check rules` tells you whether a rule file is valid. promrule-lint tells you whether the rules will behave: alerts that fire on a single bad scrape, `rate()` windows too short to ever return a value, aggregations that hide counter resets, and alerts that reach the on-call engineer without a runbook.

```text
$ npx github:OTA-EITA/promrule-lint test/fixtures/bad
test/fixtures/bad/rules.yml:4  HIGH   PR006  rate(...[30s]) in HighErrorRate covers fewer than 2 scrape intervals of 1m
test/fixtures/bad/rules.yml:16  HIGH   PR008  RequestsDropped applies rate() to sum(), so counter resets are not detected
test/fixtures/bad/rules.yml:4  MEDIUM PR001  HighErrorRate has no for, so it fires on a single evaluation
test/fixtures/bad/rules.yml:8  MEDIUM PR007  CpuSpike uses irate(), which Prometheus documents for graphs, not alerts
test/fixtures/bad/rules.yml:22  MEDIUM PR010  CpuSpike duplicates the alert on line 8 with the same labels
test/fixtures/bad/rules.yml:4  LOW    PR004  HighErrorRate has no runbook_url annotation
```

Works on plain Prometheus rule files and on Kubernetes `PrometheusRule` resources (prometheus-operator, kube-prometheus-stack), including multi-document YAML. Directories are searched for rule files; workflows and other manifests are skipped.

## Tested on real rule sets

| Rule set                                                                                                                                      | Rules                          | Findings                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [kube-prometheus](https://github.com/prometheus-operator/kube-prometheus) `manifests/*prometheusRule.yaml` (f71fb6c), `--scrape-interval 30s` | 139 alerts, 96 recording rules | 10 alerts without `for`, 2 with severity `none`, 1 without a summary                                                                     |
| [awesome-prometheus-alerts](https://github.com/samber/awesome-prometheus-alerts) `dist/rules` (736370e), default 1m scrape interval           | 1,162 alerts in 112 files      | 255 alerts with `for: 0m`, 98 alerts whose `[1m]` range is too short for a 1m scrape interval, and none of the 1,162 has a `runbook_url` |

Every rule was tuned against these: for example, `Watchdog`-style heartbeat alerts (`vector(1)`) are not asked for a `for`, and kubernetes-mixin's `:metric:sum` recording rule names are accepted.

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

Where the checks come from, in Prometheus's own words:

- `irate`: _"Use `rate` for alerts and slow-moving counters, as brief changes in the rate can reset the `FOR` clause"_ ([functions](https://prometheus.io/docs/prometheus/latest/querying/functions/#irate))
- `rate` with aggregation: _"always take a `rate()` first, then aggregate. Otherwise `rate()` cannot detect counter resets"_ ([functions](https://prometheus.io/docs/prometheus/latest/querying/functions/#rate))
- Short ranges: `deriv`, `irate` and `idelta` need two samples per the docs; for `rate`/`increase`/`delta`, `extrapolatedRate` in [`promql/functions.go`](https://github.com/prometheus/prometheus/blob/main/promql/functions.go) returns nothing for a single sample
- Naming: _"Recording rules should be of the general form `level:metric:operations`"_ ([rules practices](https://prometheus.io/docs/practices/rules/))

## Usage

```sh
npx github:OTA-EITA/promrule-lint [options] [path ...]
```

| Option                | Default                 |                                                                                                                            |
| --------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--scrape-interval`   | `1m`                    | Scrape interval your rules run against (Prometheus's default is 1m; kube-prometheus scrapes most targets every 15s or 30s) |
| `--min-window-factor` | `2`                     | A range must cover this many scrape intervals. 2 is the hard minimum; many teams use 4 to survive a missed scrape          |
| `--severities`        | `critical,warning,info` | Allowed `severity` values                                                                                                  |
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
  - uses: OTA-EITA/promrule-lint@v0.1.0 # pin to a commit SHA in real use
    id: lint
    with:
      path: deploy/monitoring
      scrape-interval: 30s
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

Dependencies are locked to versions published at least 7 days ago and checked in CI with [lockfile-guard](https://github.com/OTA-EITA/lockfile-guard); workflows are pinned and checked with [gha-guard](https://github.com/OTA-EITA/gha-guard).

## Related

- [alert-router](https://github.com/OTA-EITA/alert-router): routes Alertmanager notifications to Slack with deduplication and runbook links
- [slo-report](https://github.com/OTA-EITA/slo-report): generates multi-window burn-rate alerts from SLO definitions

## License

MIT
