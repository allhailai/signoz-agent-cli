# Control Tower Debugging With SigNoz Agent

Use this primary reference for Control Tower API investigations backed by SigNoz service discovery, traces, and logs.

## Ground Rules

- Work from `/workspace/signoz-agent-cli`.
- Do not read, print, or commit `.env`; it is local and ignored.
- Confirm `SIGNOZ_API_URL` and `SIGNOZ_API_KEY` are present without showing their values.
- Use compact text output first. Use `--json` for parsed output and `--raw` for query diagnostics.

## Investigation Flow

Validate SigNoz access:

```bash
signoz-agent doctor
```

Discover and select the API service:

```bash
signoz-agent services list --since 2h
signoz-agent services select control-tower-api
```

Search selected-service traces and logs:

```bash
signoz-agent traces search --since 30m
signoz-agent logs search --contains "timeout" --since 30m
```

`traces search` creates trace refs such as `@t1`; `logs search` creates log refs such as `@l1`.

Inspect a trace and correlated logs:

```bash
signoz-agent trace inspect @t1
signoz-agent trace logs @t1
```

Use direct filters when the relevant attribute is known:

```bash
signoz-agent traces search --filter "barry.agent_run_id = '4'" --since 2h
signoz-agent logs search --filter "barry.agent_run_id = '4'" --since 2h
```

Use body search for snippets or opaque IDs:

```bash
signoz-agent logs search --contains "hello world" --since 2h
signoz-agent logs search --contains "8dbe9558fe874905a8458d3ac068ed60" --raw
```

## Reporting Findings

Report whether `doctor` passed, the selected service, trace/log refs inspected, key errors or latency signals, and any uncertainty such as empty correlated logs.
