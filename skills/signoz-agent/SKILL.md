---
name: signoz-agent
description: Use the SigNoz agent CLI to discover services, select a service, search traces/logs, inspect traces, and retrieve correlated logs with signoz-agent-cli.
---

# SigNoz Agent CLI

Use this skill when investigating SigNoz telemetry with the `signoz-agent` command.

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

## References

- For a complete investigation workflow, read [references/service-investigation.md](references/service-investigation.md).
