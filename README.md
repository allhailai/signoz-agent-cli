# signoz-agent-cli

Agent-first CLI for discovering SigNoz services, selecting a service, and searching traces/logs.

## Installation

Install globally:

```bash
npm install --global @allhail/signoz-agent
signoz-agent --help
```

Or run a command without installing:

```bash
npx @allhail/signoz-agent doctor
```

For local development:

```bash
npm install
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

Discover recent services, select one, then search traces and logs without repeating `--service`:

```bash
signoz-agent services list --since 2h
signoz-agent services select checkout-api
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
signoz-agent traces search --filter "deployment.environment = 'production'" --since 2h
signoz-agent logs search --filter "request.id = 'abc123'" --since 2h
```

Use log body search for snippets, task IDs, or messages:

```bash
signoz-agent logs search --contains "connection timeout" --since 2h
signoz-agent logs search --contains "abc123" --raw
```

Add `--json` when an agent or script needs parsed output. Add `--raw` when debugging SigNoz query construction; it prints the request payload and compact response shape, not parsed rows.

If a ref is missing, rerun the search that created it or pass the full trace ID.

## Validation

Before opening a PR or handing off changes, run:

```bash
npm run format:check
npm run type-check
npm run lint
npm run test
```
