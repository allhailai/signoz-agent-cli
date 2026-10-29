# signoz-agent-cli

Agent-first CLI for discovering SigNoz services, searching traces/logs, and inspecting and updating alert rules.

## Installation

Install globally:

```bash
npm install --global @allhailai/signoz-agent
signoz-agent --help
```

Or run a command without installing:

```bash
npx @allhailai/signoz-agent doctor
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

Run `doctor` first to verify configuration, authentication, and API reachability, and report the server version and rules list API tier (`v2` or `v3`). A failed version probe reports `version=unknown` (`null` in JSON) and its `versionProbe` status without failing an otherwise healthy check:

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

## Alert rules

List configured alert rules, including inactive and disabled rules, then inspect a rule's full definition:

```bash
signoz-agent alerts list
signoz-agent alerts list --limit 20 --offset 20 --json
signoz-agent alerts inspect <rule-id> --json
```

Rules are listed across services, independently of the selected service and telemetry time windows. JSON lists include `count`, `total`, `nextOffset` (null on the last page), and `rules`. Inspection returns `{ "ok": true, "rule": { ... } }`, preserving all definition fields. Text inspection prints the full definition as indented JSON.

Listing probes `GET /api/v1/version` once per command without an API key. Servers below v0.144.0 use `GET /api/v2/rules`, fetching all rules and applying `--limit` and `--offset` locally; v0.144.0 and later use `GET /api/v3/rules` with server-side pagination. An unavailable or unparseable version selects v3. Both tiers return the same summaries and pagination fields. Inspection and updates use `/api/v2/rules/{id}`. See the [SigNoz rule API migration guide](https://signoz.io/docs/alerts-management/migrate-alert-rules-schema-v1-to-v2alpha1/).

To change a rule, supply a JSON object containing the writable fields to update:

```json
{
  "description": "Counts unexpected production error traces."
}
```

```bash
signoz-agent alerts update <rule-id> --patch-file change.json --dry-run
signoz-agent alerts update <rule-id> --patch-file change.json --json
cat change.json | signoz-agent alerts update <rule-id> --patch-file - --dry-run --json
```

The command fetches the current definition and merges nested objects before sending a partial update with `PATCH`. **Arrays replace the entire stored array.** When editing a query filter, include every query to retain in `condition.compositeQuery.queries`; the same applies to threshold and channel arrays. To prepare a query edit from the inspected definition:

```bash
signoz-agent alerts inspect <rule-id> --json > rule.json
jq '{condition: .rule.condition}' rule.json > change.json
# Edit the desired query in change.json and retain its sibling queries.
signoz-agent alerts update <rule-id> --patch-file change.json --dry-run
```

A dry run returns the fetched `rule` and a `changes` list with JSON Pointer paths and before/after values. It sends no write and does not validate the patch with the server. It reports `dryRun: true` and `verified: false`.

An update reads the rule back, checks the requested values, and returns the saved definition with `verified: true`. Equivalent duration strings such as `5m` and `5m0s` compare equally. A patch that already matches the rule sends no write. Failed or uncertain updates exit nonzero and are not retried automatically; inspect the rule before retrying an unconfirmed update. Updates require an API key with edit access. The command does not send test notifications.

## Validation

Before opening a PR or handing off changes, run:

```bash
npm run format:check
npm run type-check
npm run lint
npm run test
```

## Publishing

The package is public under `@allhailai/signoz-agent`. GitHub Actions publishes
through npm trusted publishing, without a stored npm write token.

For the first publication under this scope, authenticate as an npm maintainer
with publication permission and run `npm publish` from the checkout. The package
must exist before npm lets you configure a trusted publisher.

In the package's npm settings, add a GitHub Actions trusted publisher for
organization `allhailai`, repository `signoz-agent-cli`, and workflow file
`publish.yml`. Leave the environment field empty and enable **Allow npm publish**
for direct publication. This setup requires an authenticated npm account with
package write access and 2FA; a token that bypasses 2FA cannot configure trust.

See [npm's setup requirements](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
and [trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).
Complete the first successful OIDC publication within two days of creating the
trusted publisher.

For each later release, update `package.json`, `package-lock.json`, and the CLI's
version in `src/cli.ts`, then merge to `main`. Every push to `main` runs **Publish
npm package**. The workflow checks formatting, types, lint, and tests before
publishing with provenance. You can also run it manually on `main`.

The workflow publishes the committed version and skips publication when that
version is already on npm. Authentication, build, and other publication errors
fail the workflow. Use a new version when a merge should publish a new package;
the workflow does not change versions automatically.
