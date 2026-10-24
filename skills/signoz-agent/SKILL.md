---
name: signoz-agent
description: Use signoz-agent to investigate SigNoz traces, logs, and alert definitions, or apply requested alert rule changes.
---

# SigNoz Agent CLI

Use this skill when investigating SigNoz telemetry or managing alert rules with the `signoz-agent` command.

## Quick Start

```bash
signoz-agent doctor
signoz-agent services list --since 2h
signoz-agent services select checkout-api
signoz-agent traces search --since 30m
signoz-agent logs search --contains "timeout" --since 30m
signoz-agent trace inspect @t1
signoz-agent trace logs @t1
```

Trace searches assign refs such as `@t1`; log searches assign refs such as `@l1`. Rerun the relevant search if a ref is missing.

The CLI requires `SIGNOZ_API_URL` and `SIGNOZ_API_KEY` in the environment. `.env` is local, ignored by git, and must not be printed or committed. Confirm env vars exist without exposing values.

## Search Patterns

Use the selected service for normal trace/log exploration:

```bash
signoz-agent services list --since 2h
signoz-agent services select checkout-api
signoz-agent traces search --since 30m
signoz-agent logs search --contains "timeout" --since 30m
```

Use direct filters for known attributes:

```bash
signoz-agent traces search --filter "deployment.environment = 'production'" --since 2h
signoz-agent logs search --filter "request.id = 'abc123'" --since 2h
```

Use contains search for log body snippets:

```bash
signoz-agent logs search --contains "connection timeout" --since 2h
```

Use `--json` for parsed output. Use `--raw` for query diagnostics when SigNoz results are surprising:

```bash
signoz-agent logs search --contains "abc123" --raw
```

## Alert rules

Read saved rule definitions when investigating why telemetry triggers an alert:

```bash
signoz-agent alerts list --json
signoz-agent alerts inspect <rule-id> --json
```

Lists include inactive and disabled rules and are independent of the selected service. Follow `nextOffset` with `--offset` to read further pages. Inspection returns the full definition under `rule`, including the query, thresholds, and evaluation and notification settings.

For requested alert changes, prepare a partial rule JSON file and preview it:

```bash
signoz-agent alerts update <rule-id> --patch-file change.json --dry-run --json
signoz-agent alerts update <rule-id> --patch-file change.json --json
```

Nested objects merge with the current definition, but arrays replace the entire stored array. Include all queries, thresholds, and channels that the change must retain. Use `--patch-file -` for JSON from stdin. Supply writable rule fields directly, without the inspection envelope or audit fields.

A dry run shows requested changes without writing or server validation. An update requires edit access and reads back the saved rule to verify it. If an update is unconfirmed or verification fails, inspect the rule before deciding whether another write is necessary. An investigation alone does not authorize alert changes.

## References

- For a complete investigation workflow, read [references/service-investigation.md](references/service-investigation.md).
