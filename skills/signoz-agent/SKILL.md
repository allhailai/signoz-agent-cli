---
name: signoz-agent
description: Use the SigNoz agent CLI to investigate traces and correlated logs, especially Barry webhook failures. Use when the user asks to debug SigNoz telemetry, inspect traces, or retrieve trace logs with signoz-agent-cli.
---

# SigNoz Agent CLI

Use this skill when investigating SigNoz traces with `/workspace/signoz-agent-cli`.

## Quick Start

Work from `/workspace/signoz-agent-cli` and use only the implemented commands:

```bash
signoz-agent doctor
signoz-agent traces search --service barry --route "/webhooks/signoz" --status ">=400" --since 30m
signoz-agent trace inspect @t1
signoz-agent trace logs @t1
```

The CLI requires `SIGNOZ_API_URL` and `SIGNOZ_API_KEY` in the environment. `.env` is local, ignored by git, and must not be printed or committed.

## References

- For the detailed Barry investigation flow, read [references/barry-debugging.md](references/barry-debugging.md).
