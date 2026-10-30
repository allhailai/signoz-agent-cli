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

`alerts update` and `alerts apply` use `SIGNOZ_WRITE_API_KEY` for writes and test notifications when it is non-empty, otherwise `SIGNOZ_API_KEY`. Reads always use `SIGNOZ_API_KEY`. Reports identify the variable as `writeKeySource`, never print the key.

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

Lists include inactive and disabled rules and are independent of the selected service. The CLI probes the server version without authentication: below v0.144.0 it fetches `/api/v2/rules` and pages locally; v0.144.0 and later use `/api/v3/rules`. An unknown or unparseable version selects v3. `doctor` reports `version`, `rulesListApi`, and `versionProbe` in text and JSON; a failed version probe is nonfatal on its own. Follow `nextOffset` with `--offset` to read further pages. Inspection returns the full definition under `rule`, including the query, thresholds, and evaluation and notification settings.

For requested alert changes, prepare a partial rule JSON file and preview it:

```bash
signoz-agent alerts update <rule-id> --patch-file change.json --dry-run --json
signoz-agent alerts update <rule-id> --patch-file change.json --json
```

Nested objects merge with the current definition, but arrays replace the entire stored array. Include all queries, thresholds, and channels that the change must retain. Use `--patch-file -` for JSON from stdin. Supply writable rule fields directly, without the inspection envelope or audit fields.

A dry run shows requested changes without writing or server validation. An update requires edit access and reads back the saved rule to verify it. If an update is unconfirmed or verification fails, inspect the rule before deciding whether another write is necessary. An investigation alone does not authorize alert changes.

### Apply complete definitions

For requested creates or replacements, put one complete rule definition in each top-level `*.json` file. Files must have `schemaVersion: "v2alpha1"` and a non-empty `alert`, and omit `id`, `state`, `createdAt`, `createdBy`, `updatedAt`, and `updatedBy`. Include all condition, evaluation, and notification settings to retain: updates send the file as a full PUT replacement. Comparison checks supplied fields, including equivalent durations; clear optional values explicitly using empty or null values accepted by SigNoz.

Export a file with the existing inspect command and `jq`:

```bash
mkdir -p ./rules
signoz-agent alerts inspect <rule-id> --json \
  | jq '.rule | del(.id, .state, .createdAt, .createdBy, .updatedAt, .updatedBy, .version, .source)' \
  > ./rules/example.json
signoz-agent alerts apply --dir ./rules --dry-run --json
signoz-agent alerts apply --dir ./rules --json
```

An unchanged export is a no-op. Files are processed in filename order. Exact alert names determine `create`, `update`, `unchanged`, or `ambiguous`; duplicate live names are never written. Invalid files are reported as `invalid`. Creates report their new ids; creates and updates are read back for verification, including PUT's empty 204 response. Other files continue after a failure, and any failure exits 1. Inspect unconfirmed or unverifiable writes before rerunning; repeated names with an unverified write are held back in the same run. Equivalent files are no-ops on re-run.

`--json` reports `ok`, `dryRun`, `writeKeySource`, and per-file `results` with file, alert, action, id, changes, test result, and error. Failed reports go to stderr. `--dry-run` is the diff preview and sends no writes or notifications.

**`--test` sends real test notifications to the definition's channels.** Only use it when the user requests those notifications. It is off by default; when set, it calls `/api/v2/rules/test` before each create or update and reports `alertCount`. A failed test prevents the write; a lost response may already have sent a notification and is not retried. `--dry-run --test` still sends nothing. Deletion remains in the UI.

## References

- For a complete investigation workflow, read [references/service-investigation.md](references/service-investigation.md).
