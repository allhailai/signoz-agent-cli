# Barry Debugging With SigNoz Agent

Use this reference when the user asks for a Barry failure investigation backed by SigNoz traces and logs.

## Ground Rules

- Work from `/workspace/signoz-agent-cli`.
- Do not read, print, or commit `.env`; it is local and ignored.
- Confirm `SIGNOZ_API_URL` and `SIGNOZ_API_KEY` are present without showing their values.
- Prefer compact text output for interactive investigation. Use `--json` when the result will be parsed or summarized programmatically.
- Only use implemented commands: `doctor`, `traces search`, `trace inspect`, and `trace logs`.

## Investigation Flow

Start by validating the local SigNoz setup:

```bash
signoz-agent doctor
```

Search for recent failing Barry webhook traces:

```bash
signoz-agent traces search --service barry --route "/webhooks/signoz" --status ">=400" --since 30m
```

The search output creates session-local trace refs such as `@t1`. Pick the ref with the clearest failure signal, usually the newest high-status or long-duration request.

Inspect spans for that trace:

```bash
signoz-agent trace inspect @t1
```

Then fetch correlated logs for the same trace:

```bash
signoz-agent trace logs @t1
```

## Reporting Findings

Summarize the investigation in this order:

1. Whether `doctor` passed.
2. The trace ref or trace ID investigated.
3. The failing route, status, duration, and relevant span names.
4. Correlated log messages that explain the failure.
5. Any uncertainty, such as an empty log result or a missing ref.

If a ref is missing, rerun `traces search` or use a full trace ID. If `doctor` fails, stop and report the missing config, authentication, or reachability issue without exposing secrets.
