# signoz-agent-cli

Agent-first CLI for discovering SigNoz services, selecting a service, and searching traces/logs.

## Setup

Install dependencies and build the local CLI:

```bash
npm install
npm run build
```

For local development, run commands through the TypeScript entrypoint:

```bash
npm run dev -- doctor
npm run dev -- services list --since 2h
```

To try the compiled command locally:

```bash
npm run build
npm link
signoz-agent doctor
```

## Environment

The CLI reads SigNoz connection settings from environment variables:

- `SIGNOZ_API_URL`: SigNoz API base URL.
- `SIGNOZ_API_KEY`: SigNoz API key.

Use a local `.env` file or shell exports for development, but do not print or commit secrets. This repo ignores `.env` and `.env.*` files by default. Confirm env vars are present without exposing their values.

Example shell setup with placeholders:

```bash
export SIGNOZ_API_URL="<your-signoz-api-base-url>"
export SIGNOZ_API_KEY="<your-signoz-api-key>"
```

## Commands

Run `doctor` first to verify configuration, authentication, and API reachability:

```bash
signoz-agent doctor
```

Primary Control Tower API workflow: discover recent services, select the API service, then search traces and logs without repeating `--service`:

```bash
signoz-agent services list --since 2h
signoz-agent services select control-tower-api
signoz-agent traces search --since 30m
signoz-agent logs search --contains "timeout" --since 30m
```

Trace searches create session-local refs such as `@t1`; log searches create refs such as `@l1`. Inspect spans or fetch correlated logs with a trace ID or trace ref:

```bash
signoz-agent trace inspect @t1
signoz-agent trace logs @t1
```

Use direct SigNoz filter expressions when the relevant attribute is known:

```bash
signoz-agent traces search --filter "barry.agent_run_id = '4'" --since 2h
signoz-agent logs search --filter "barry.agent_run_id = '4'" --since 2h
```

Use log body search for snippets, task IDs, or messages:

```bash
signoz-agent logs search --contains "hello world" --since 2h
signoz-agent logs search --contains "8dbe9558fe874905a8458d3ac068ed60" --raw
```

Add `--json` when an agent or script needs parsed output. Add `--raw` when debugging SigNoz query construction; it prints the request payload and compact response shape, not parsed rows.

## Secondary Workflows

Use this flow when debugging Barry webhook failures in SigNoz:

```bash
signoz-agent doctor
signoz-agent traces search --service barry --route "/webhooks/signoz" --status ">=400" --since 30m
signoz-agent trace inspect @t1
signoz-agent trace logs @t1
```

For Barry/OpenCode smoke work, attribute and body searches can find logs that are not trace-correlated:

```bash
signoz-agent traces search --filter "barry.agent_run_id = '4'" --since 2h
signoz-agent logs search --filter "barry.agent_run_id = '4'" --since 2h
signoz-agent logs search --contains "hello world" --since 2h
```

If a ref is missing, rerun the search that created it or pass the full trace ID.

## Validation

Before opening a PR or handing off changes, run:

```bash
npm run format:check
npm run type-check
npm run lint
npm run test
```
