# Service Investigation With SigNoz Agent

Use this reference to investigate service failures through SigNoz traces and logs.

## Ground Rules

- Do not read, print, or commit credentials.
- Confirm `SIGNOZ_API_URL` and `SIGNOZ_API_KEY` are present without showing their values.
- Use compact text output first, `--json` for parsed output, and `--raw` for query diagnostics.

## Investigation Flow

Validate SigNoz access, discover recent services, and select one:

```bash
signoz-agent doctor
signoz-agent services list --since 2h
signoz-agent services select checkout-api
```

Search the selected service:

```bash
signoz-agent traces search --since 30m
signoz-agent logs search --contains "timeout" --since 30m
```

Trace and log searches create session-local refs such as `@t1` and `@l1`. Inspect a trace and its correlated logs:

```bash
signoz-agent trace inspect @t1
signoz-agent trace logs @t1
```

When the relevant attribute is known, search directly:

```bash
signoz-agent traces search --filter "deployment.environment = 'production'" --since 2h
signoz-agent logs search --filter "request.id = 'abc123'" --since 2h
```

If correlated logs are empty, search by a known message or opaque identifier:

```bash
signoz-agent logs search --contains "connection timeout" --since 2h
signoz-agent logs search --contains "abc123" --raw
```

## Reporting Findings

Report whether `doctor` passed, the selected service, trace or log refs inspected, key errors or latency signals, and uncertainty such as empty correlated logs.
