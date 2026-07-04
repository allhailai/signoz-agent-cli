# signoz-agent-cli

Agent-first CLI for investigating SigNoz traces and correlated logs.

## Setup

Install dependencies and build the local CLI:

```bash
npm install
npm run build
```

For local development, run commands through the TypeScript entrypoint:

```bash
npm run dev -- doctor
npm run dev -- traces search --service barry --route "/webhooks/signoz" --status ">=400" --since 30m
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

Use a local `.env` file or shell exports for development, but do not commit secrets. This repo ignores `.env` and `.env.*` files by default.

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

Search failing traces and create session-local refs such as `@t1`:

```bash
signoz-agent traces search --service barry --route "/webhooks/signoz" --status ">=400" --since 30m
```

Inspect spans for a trace ID or session ref:

```bash
signoz-agent trace inspect @t1
```

Find correlated logs for a trace ID or session ref:

```bash
signoz-agent trace logs @t1
```

Add `--json` to any command when an agent or script needs structured output.

## Barry Workflow

Use this flow when debugging Barry webhook failures in SigNoz:

```bash
signoz-agent doctor
signoz-agent traces search --service barry --route "/webhooks/signoz" --status ">=400" --since 30m
signoz-agent trace inspect @t1
signoz-agent trace logs @t1
```

If the search returns multiple refs, inspect the trace with the clearest failure signal first, then fetch logs for the same ref. If a ref is missing, rerun `traces search` or pass a full trace ID.

## Validation

Before opening a PR or handing off changes, run:

```bash
npm run format:check
npm run type-check
npm run lint
npm run test
```
