import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const firstId = "01900000-0000-7000-8000-000000000001";
const secondId = "01900000-0000-7000-8000-000000000002";
const exportFilter =
  ".rule | del(.id, .state, .createdAt, .createdBy, .updatedAt, .updatedBy, .version, .source)";

type Rule = ReturnType<typeof liveRule>;
type Request = {
  method: string | undefined;
  url: string;
  apiKey: string | string[] | undefined;
  body: Record<string, unknown>;
};
type Reply = { status?: number; body?: unknown; disconnect?: boolean };
type State = { rules: Rule[] };
type CliResult = { exitCode: number; stdout: string; stderr: string };
type Context = { url: string; requests: Request[]; state: State };

function definition(alert = "Existing rule") {
  return {
    alert,
    schemaVersion: "v2alpha1",
    alertType: "TRACES_BASED_ALERT",
    ruleType: "threshold_rule",
    description: "Original description",
    disabled: false,
    labels: { team: "platform" },
    condition: {
      compositeQuery: {
        queries: [
          { type: "builder_query", spec: { name: "A", signal: "traces" } },
        ],
      },
      selectedQueryName: "A",
      thresholds: {
        kind: "basic",
        spec: [{ name: "critical", target: 5, op: "above" }],
      },
    },
    evaluation: {
      kind: "rolling",
      spec: { evalWindow: "5m", frequency: "1m" },
    },
    notificationSettings: { renotify: { enabled: true, interval: "4h" } },
  };
}

function liveRule(alert = "Existing rule", id = firstId) {
  const rule = definition(alert);
  return {
    ...rule,
    id,
    state: "inactive",
    createdAt: "2026-10-30T00:00:00Z",
    createdBy: "user-id",
    updatedAt: "2026-10-30T00:00:00Z",
    updatedBy: "user-id",
    version: "v5",
    source: "legacy",
    evaluation: {
      ...rule.evaluation,
      spec: { evalWindow: "5m0s", frequency: "1m0s" },
    },
    notificationSettings: { renotify: { enabled: true, interval: "4h0m0s" } },
  };
}

function report(result: CliResult) {
  return JSON.parse(result.exitCode === 0 ? result.stdout : result.stderr);
}

describe("alerts apply", () => {
  it.each([false, true])(
    "replaces an empty object and detects an ignored replacement (ignored=%s)",
    async (ignored) => {
      await withFiles(
        { "clear.json": { ...definition(), labels: {} } },
        async (dir) => {
          await withServer(
            "v0.141.1",
            [liveRule()],
            async ({ url, requests }) => {
              const result = await runCli(url, [
                "alerts",
                "apply",
                "--dir",
                dir,
                "--json",
              ]);
              expect(result.exitCode).toBe(ignored ? 1 : 0);
              expect(report(result).results[0]).toMatchObject({
                action: "update",
                id: firstId,
                changes: [
                  { path: "/labels", before: { team: "platform" }, after: {} },
                ],
                error: ignored
                  ? { code: "verification_failed", writeStatus: "accepted" }
                  : null,
              });
              expect(
                requests.filter(({ method }) => method === "PUT"),
              ).toHaveLength(1);
            },
            (request) =>
              ignored && request.method === "PUT" ? { status: 204 } : undefined,
          );
        },
      );
    },
  );

  it.each(["v0.141.1", "v0.144.0"])(
    "dry-runs all outcomes using %s without writes or test notifications",
    async (version) => {
      await withFiles(
        {
          "04-ambiguous.json": definition("Duplicate"),
          "02-update.json": {
            ...definition("Changed"),
            description: "New description",
          },
          "03-unchanged.json": definition(),
          "01-create.json": definition("New rule"),
          "05-invalid.json": { ...definition(), id: firstId },
          "ignored.txt": "not a rule",
        },
        async (dir) => {
          await withServer(
            version,
            [
              liveRule(),
              liveRule("Changed", secondId),
              liveRule("Duplicate", "duplicate-1"),
              liveRule("Duplicate", "duplicate-2"),
            ],
            async ({ url, requests }) => {
              const result = await runCli(url, [
                "alerts",
                "apply",
                "--dir",
                dir,
                "--dry-run",
                "--test",
                "--json",
              ]);
              expect(result.exitCode).toBe(1);
              expect(result.stdout).toBe("");
              const body = report(result);
              expect(body).toMatchObject({
                ok: false,
                dryRun: true,
                writeKeySource: "SIGNOZ_WRITE_API_KEY",
              });
              expect(
                body.results.map((row: { action: string }) => row.action),
              ).toEqual([
                "create",
                "update",
                "unchanged",
                "ambiguous",
                "invalid",
              ]);
              expect(
                body.results.map((row: { file: string }) => row.file),
              ).toEqual([
                "01-create.json",
                "02-update.json",
                "03-unchanged.json",
                "04-ambiguous.json",
                "05-invalid.json",
              ]);
              expect(body.results[1]).toMatchObject({
                id: secondId,
                changes: [
                  {
                    path: "/description",
                    before: "Original description",
                    after: "New description",
                  },
                ],
                test: null,
                error: null,
              });
              expect(body.results[2].changes).toEqual([]);
              expect(body.results[3].error.code).toBe("ambiguous");
              expect(body.results[4].error.code).toBe("invalid_definition");
              expect(requests.every(({ method }) => method === "GET")).toBe(
                true,
              );
              expect(requests[0]).toMatchObject({
                url: "/signoz/api/v1/version",
                apiKey: undefined,
              });
              expect(
                requests.filter(({ url }) => url.endsWith("/version")),
              ).toHaveLength(1);
              if (version === "v0.141.1") {
                expect(requests.map(({ url }) => url)).toEqual([
                  "/signoz/api/v1/version",
                  "/signoz/api/v2/rules",
                ]);
              } else {
                expect(requests.slice(1, 5).map(({ url }) => url)).toEqual(
                  [0, 1, 2, 3].map(
                    (offset) =>
                      `/signoz/api/v3/rules?limit=200&offset=${offset}`,
                  ),
                );
                expect(requests.slice(5).map(({ url }) => url)).toEqual([
                  `/signoz/api/v2/rules/${secondId}`,
                  `/signoz/api/v2/rules/${firstId}`,
                ]);
              }
              const text = await runCli(url, [
                "alerts",
                "apply",
                "--dir",
                dir,
                "--dry-run",
              ]);
              expect(text.exitCode).toBe(1);
              expect(text.stderr).toContain(
                'create "New rule" file="01-create.json" new rule',
              );
              expect(text.stderr).toContain('update "Changed"');
              expect(text.stderr).toContain('unchanged "Existing rule"');
              expect(text.stderr).toContain('ambiguous "Duplicate"');
              expect(text.stderr).toContain("Next:\n");
              expect(text.stderr).toContain("no writes or test notifications");
            },
          );
        },
      );
    },
  );

  it.each(["v0.141.1", "v0.144.0"])(
    "creates with 201, replaces with 204, verifies, and reruns as no-ops on %s",
    async (version) => {
      const changed = { ...definition(), description: "Replaced", labels: {} };
      await withFiles(
        { "b-update.json": changed, "a-create.json": definition("New rule") },
        async (dir) => {
          await withServer(
            version,
            [liveRule()],
            async ({ url, requests, state }) => {
              const first = await runCli(url, [
                "alerts",
                "apply",
                "--dir",
                dir,
                "--json",
              ]);
              expect(first.exitCode).toBe(0);
              const body = report(first);
              expect(body).toMatchObject({
                ok: true,
                dryRun: false,
                writeKeySource: "SIGNOZ_WRITE_API_KEY",
                results: [
                  { action: "create", id: expect.any(String), error: null },
                  { action: "update", id: firstId, error: null },
                ],
              });
              const writes = requests.filter(
                ({ method }) => method === "POST" || method === "PUT",
              );
              expect(writes.map(({ method, url }) => [method, url])).toEqual([
                ["POST", "/signoz/api/v2/rules"],
                ["PUT", `/signoz/api/v2/rules/${firstId}`],
              ]);
              expect(writes[1]?.body).toEqual(changed);
              expect(
                state.rules.find(({ id }) => id === firstId)?.labels,
              ).toEqual({});
              const putIndex = requests.findIndex(
                ({ method }) => method === "PUT",
              );
              expect(requests[putIndex + 1]).toMatchObject({
                method: "GET",
                url: `/signoz/api/v2/rules/${firstId}`,
                apiKey: "read-secret",
              });
              expect(
                requests
                  .filter(({ method }) => method !== "GET")
                  .every(({ apiKey }) => apiKey === "write-secret"),
              ).toBe(true);
              const before = requests.length;
              const repeated = await runCli(url, [
                "alerts",
                "apply",
                "--dir",
                dir,
                "--json",
              ]);
              expect(repeated.exitCode).toBe(0);
              expect(
                report(repeated).results.map(
                  (row: { action: string }) => row.action,
                ),
              ).toEqual(["unchanged", "unchanged"]);
              expect(
                requests.slice(before).every(({ method }) => method === "GET"),
              ).toBe(true);
            },
          );
        },
      );
    },
  );

  it.each(["write-secret", ""])(
    "uses the selected write key for notifications and writes (%j)",
    async (writeKey) => {
      await withFiles(
        {
          "a-create.json": definition("New rule"),
          "b-update.json": { ...definition(), description: "Changed" },
          "c-unchanged.json": definition("Unchanged"),
        },
        async (dir) => {
          await withServer(
            "v0.141.1",
            [liveRule(), liveRule("Unchanged", secondId)],
            async ({ url, requests }) => {
              const result = await runCli(
                url,
                ["alerts", "apply", "--dir", dir, "--test", "--json"],
                "",
                writeKey,
              );
              expect(result.exitCode).toBe(0);
              expect(report(result).writeKeySource).toBe(
                writeKey ? "SIGNOZ_WRITE_API_KEY" : "SIGNOZ_API_KEY",
              );
              expect(
                report(result).results.map(
                  (row: { test: unknown }) => row.test,
                ),
              ).toEqual([{ alertCount: 2 }, { alertCount: 2 }, null]);
              expect(
                requests
                  .filter(({ method }) => method !== "GET")
                  .map(({ method, url, apiKey }) => [method, url, apiKey]),
              ).toEqual([
                [
                  "POST",
                  "/signoz/api/v2/rules/test",
                  writeKey || "read-secret",
                ],
                ["POST", "/signoz/api/v2/rules", writeKey || "read-secret"],
                [
                  "POST",
                  "/signoz/api/v2/rules/test",
                  writeKey || "read-secret",
                ],
                [
                  "PUT",
                  `/signoz/api/v2/rules/${firstId}`,
                  writeKey || "read-secret",
                ],
              ]);
              expect(
                requests
                  .filter(
                    ({ method, url }) =>
                      method === "GET" && !url.endsWith("/version"),
                  )
                  .every(({ apiKey }) => apiKey === "read-secret"),
              ).toBe(true);
            },
          );
        },
      );
    },
  );

  it.each<Reply>([
    { status: 403, body: { message: "read-secret write-secret" } },
    { body: { message: "write-secret" } },
    { disconnect: true },
  ])(
    "does not write after a failed test and continues other files (%j)",
    async (failure) => {
      await withFiles(
        { "a-bad.json": definition("Bad"), "b-good.json": definition("Good") },
        async (dir) => {
          await withServer(
            "v0.141.1",
            [],
            async ({ url, requests }) => {
              const result = await runCli(url, [
                "alerts",
                "apply",
                "--dir",
                dir,
                "--test",
                "--json",
              ]);
              expect(result.exitCode).toBe(1);
              expect(report(result).results).toMatchObject([
                { action: "create", error: { code: "test_failed" } },
                { action: "create", test: { alertCount: 2 }, error: null },
              ]);
              expect(
                requests
                  .filter(
                    ({ method, url }) =>
                      method === "POST" && url === "/signoz/api/v2/rules",
                  )
                  .map(({ body }) => body.alert),
              ).toEqual(["Good"]);
            },
            (request) =>
              request.url.endsWith("/test") && request.body.alert === "Bad"
                ? failure
                : undefined,
          );
        },
      );
    },
  );

  it.each(["ignored", "readback-failed", "lost", "rejected"])(
    "reports a %s PUT and continues other files",
    async (mode) => {
      await withFiles(
        {
          "a-update.json": { ...definition(), description: "Changed" },
          "b-create.json": definition("Good"),
        },
        async (dir) => {
          let written = false;
          await withServer(
            "v0.141.1",
            [liveRule()],
            async ({ url, requests }) => {
              const result = await runCli(url, [
                "alerts",
                "apply",
                "--dir",
                dir,
                "--json",
              ]);
              expect(result.exitCode).toBe(1);
              const error = report(result).results[0].error;
              expect(error.code).toBe(
                mode === "lost"
                  ? "update_unconfirmed"
                  : mode === "rejected"
                    ? "signoz_error"
                    : "verification_failed",
              );
              if (mode !== "rejected")
                expect(error.writeStatus).toBe(
                  mode === "lost" ? "unknown" : "accepted",
                );
              expect(report(result).results[1]).toMatchObject({
                action: "create",
                error: null,
              });
              expect(
                requests.filter(({ method }) => method === "PUT"),
              ).toHaveLength(1);
            },
            (request) => {
              if (request.method === "PUT") {
                written = true;
                if (mode === "ignored") return { status: 204 };
                if (mode === "lost") return { disconnect: true };
                if (mode === "rejected")
                  return {
                    status: 403,
                    body: { message: "read-secret write-secret" },
                  };
              }
              if (
                written &&
                mode === "readback-failed" &&
                request.method === "GET" &&
                request.url.endsWith(firstId)
              )
                return { status: 500, body: { message: "write-secret" } };
              return undefined;
            },
          );
        },
      );
    },
  );

  it.each(["lost", "malformed", "verification-failed"])(
    "handles a %s create without repeating the name in the same run",
    async (mode) => {
      await withFiles(
        {
          "a-create.json": definition("Uncertain"),
          "b-repeat.json": definition("Uncertain"),
          "c-good.json": definition("Good"),
        },
        async (dir) => {
          await withServer(
            "v0.141.1",
            [],
            async ({ url, requests }) => {
              const result = await runCli(url, [
                "alerts",
                "apply",
                "--dir",
                dir,
                "--json",
              ]);
              expect(result.exitCode).toBe(1);
              expect(report(result).results[0].error.code).toBe(
                mode === "verification-failed"
                  ? "verification_failed"
                  : "update_unconfirmed",
              );
              expect(report(result).results[1].error.code).toBe(
                "update_unconfirmed",
              );
              expect(report(result).results[2]).toMatchObject({
                action: "create",
                error: null,
              });
              expect(
                requests.filter(
                  ({ method, body }) =>
                    method === "POST" && body.alert === "Uncertain",
                ),
              ).toHaveLength(1);
            },
            (request) => {
              if (
                request.method === "POST" &&
                request.url.endsWith("/rules") &&
                request.body.alert === "Uncertain"
              ) {
                if (mode === "lost") return { disconnect: true };
                if (mode === "malformed")
                  return {
                    status: 201,
                    body: {
                      status: "success",
                      data: { message: "read-secret write-secret" },
                    },
                  };
                return {
                  status: 201,
                  body: {
                    status: "success",
                    data: liveRule(
                      "Uncertain",
                      "01900000-0000-7000-8000-000000000099",
                    ),
                  },
                };
              }
              return undefined;
            },
          );
        },
      );
    },
  );

  it("rejects invalid files before contacting SigNoz", async () => {
    const invalid: Record<string, unknown> = {
      "null.json": null,
      "array.json": [],
      "malformed.json": "{",
      "empty.json": { ...definition(), alert: "  " },
      "schema.json": { ...definition(), schemaVersion: "v1" },
    };
    for (const field of [
      "id",
      "state",
      "createdAt",
      "createdBy",
      "updatedAt",
      "updatedBy",
    ])
      invalid[`${field}.json`] = { ...definition(), [field]: "server-owned" };
    await withFiles(invalid, async (dir) => {
      await withServer("v0.141.1", [], async ({ url, requests }) => {
        const result = await runCli(url, [
          "alerts",
          "apply",
          "--dir",
          dir,
          "--json",
        ]);
        expect(result.exitCode).toBe(1);
        expect(report(result).results).toHaveLength(
          Object.keys(invalid).length,
        );
        expect(
          report(result).results.every(
            (row: { action: string; error: { code: string } }) =>
              row.action === "invalid" &&
              row.error.code === "invalid_definition",
          ),
        ).toBe(true);
        expect(requests).toEqual([]);
      });
    });
  });

  it.each(["v0.141.1", "v0.144.0"])(
    "round-trips the documented inspect/jq export as unchanged on %s",
    async (version) => {
      expect(await readFile("README.md", "utf8")).toContain(exportFilter);
      await withFiles({}, async (dir) => {
        await withServer(version, [liveRule()], async ({ url, requests }) => {
          const inspected = await runCli(url, [
            "alerts",
            "inspect",
            firstId,
            "--json",
          ]);
          expect(inspected.exitCode).toBe(0);
          const exported = await runProcess(
            "jq",
            [exportFilter],
            inspected.stdout,
          );
          expect(exported.exitCode).toBe(0);
          expect(JSON.parse(exported.stdout)).not.toHaveProperty("id");
          expect(JSON.parse(exported.stdout)).not.toHaveProperty("source");
          await writeFile(join(dir, "exported.json"), exported.stdout);
          const result = await runCli(url, [
            "alerts",
            "apply",
            "--dir",
            dir,
            "--json",
          ]);
          expect(result.exitCode).toBe(0);
          expect(report(result).results).toMatchObject([
            { action: "unchanged", id: firstId, changes: [], error: null },
          ]);
          expect(requests.every(({ method }) => method === "GET")).toBe(true);
        });
      });
    },
  );

  it.each([false, true])(
    "handles repeated desired names in stable order (dryRun=%s)",
    async (dryRun) => {
      await withFiles(
        { "b-same.json": definition("New"), "a-new.json": definition("New") },
        async (dir) => {
          await withServer("v0.144.0", [], async ({ url, requests }) => {
            const result = await runCli(url, [
              "alerts",
              "apply",
              "--dir",
              dir,
              "--json",
              ...(dryRun ? ["--dry-run"] : []),
            ]);
            expect(result.exitCode).toBe(0);
            expect(
              report(result).results.map(
                (row: { action: string }) => row.action,
              ),
            ).toEqual(["create", "unchanged"]);
            expect(
              requests.filter(({ method }) => method === "POST"),
            ).toHaveLength(dryRun ? 0 : 1);
          });
        },
      );
    },
  );

  it("does not create from an incomplete v3 inventory", async () => {
    await withFiles({ "new.json": definition("New") }, async (dir) => {
      await withServer(
        "v0.144.0",
        [],
        async ({ url, requests }) => {
          const result = await runCli(url, [
            "alerts",
            "apply",
            "--dir",
            dir,
            "--json",
          ]);
          expect(result.exitCode).toBe(1);
          expect(report(result).results[0].error.code).toBe(
            "unexpected_response",
          );
          expect(requests.every(({ method }) => method === "GET")).toBe(true);
        },
        (request) =>
          request.url.includes("/v3/rules")
            ? { body: { status: "success", data: { rules: [], total: 2 } } }
            : undefined,
      );
    });
  });

  it("reports an unreadable directory and handles an empty directory without contacting SigNoz", async () => {
    await withFiles({}, async (dir) => {
      await withServer("v0.141.1", [], async ({ url, requests }) => {
        const missing = await runCli(url, [
          "alerts",
          "apply",
          "--dir",
          join(dir, "missing"),
          "--json",
        ]);
        expect(missing.exitCode).toBe(1);
        expect(report(missing)).toMatchObject({
          code: "invalid_directory",
          writeKeySource: "SIGNOZ_WRITE_API_KEY",
        });
        const empty = await runCli(url, [
          "alerts",
          "apply",
          "--dir",
          dir,
          "--json",
        ]);
        expect(empty.exitCode).toBe(0);
        expect(report(empty).results).toEqual([]);
        expect(requests).toEqual([]);
      });
    });
  });
});

describe("alerts update credentials", () => {
  it.each(["write-secret", ""])(
    "uses the selected write key for PATCH and the read key for readback (%j)",
    async (writeKey) => {
      await withServer("v0.141.1", [liveRule()], async ({ url, requests }) => {
        const result = await runCli(
          url,
          ["alerts", "update", firstId, "--patch-file", "-", "--json"],
          '{"description":"Changed"}',
          writeKey,
        );
        expect(result.exitCode).toBe(0);
        expect(report(result)).toMatchObject({
          verified: true,
          writeKeySource: writeKey ? "SIGNOZ_WRITE_API_KEY" : "SIGNOZ_API_KEY",
        });
        expect(requests.map(({ method, apiKey }) => [method, apiKey])).toEqual([
          ["GET", "read-secret"],
          ["PATCH", writeKey || "read-secret"],
          ["GET", "read-secret"],
        ]);
      });
    },
  );

  it("names the key variable on failure without leaking either key", async () => {
    await withServer(
      "v0.141.1",
      [liveRule()],
      async ({ url }) => {
        const result = await runCli(
          url,
          ["alerts", "update", firstId, "--patch-file", "-", "--json"],
          '{"description":"Changed"}',
        );
        expect(result.exitCode).toBe(1);
        expect(report(result)).toMatchObject({
          code: "signoz_error",
          writeKeySource: "SIGNOZ_WRITE_API_KEY",
        });
      },
      (request) =>
        request.method === "PATCH"
          ? { status: 403, body: { message: "read-secret write-secret" } }
          : undefined,
    );
  });
});

async function withFiles(
  files: Record<string, unknown>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "signoz-apply-"));
  try {
    for (const [name, value] of Object.entries(files))
      await writeFile(
        join(dir, name),
        typeof value === "string" ? value : JSON.stringify(value),
      );
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCli(
  url: string,
  args: string[],
  input = "",
  writeKey = "write-secret",
): Promise<CliResult> {
  const result = await runProcess(
    process.execPath,
    [join(process.cwd(), "dist/cli.js"), ...args],
    input,
    {
      ...process.env,
      SIGNOZ_API_URL: url,
      SIGNOZ_API_KEY: "read-secret",
      SIGNOZ_WRITE_API_KEY: writeKey,
    },
  );
  expect(result.stdout).not.toContain("read-secret");
  expect(result.stdout).not.toContain("write-secret");
  expect(result.stderr).not.toContain("read-secret");
  expect(result.stderr).not.toContain("write-secret");
  return result;
}

function runProcess(
  command: string,
  args: string[],
  input: string,
  env = process.env,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { env, timeout: 10_000 },
      (error, stdout, stderr) =>
        resolve({
          exitCode:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
          stdout,
          stderr,
        }),
    );
    child.stdin?.end(input);
  });
}

async function withServer(
  version: string,
  rules: Rule[],
  run: (context: Context) => Promise<void>,
  override: (request: Request, state: State) => Reply | undefined = () =>
    undefined,
): Promise<void> {
  const state = { rules: structuredClone(rules) };
  const requests: Request[] = [];
  let created = 10;
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const captured = {
        method: request.method,
        url: request.url ?? "",
        apiKey: request.headers["signoz-api-key"],
        body,
      };
      requests.push(captured);
      const reply = override(captured, state) ?? respond(captured);
      if (reply.disconnect) {
        request.socket.destroy();
        return;
      }
      response.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(
        reply.status === 204 ? undefined : JSON.stringify(reply.body ?? {}),
      );
    });
  });
  function success(data: unknown): Reply {
    return { body: { status: "success", data } };
  }
  function respond(request: Request): Reply {
    const parsed = new URL(request.url, "http://localhost");
    const path = parsed.pathname;
    if (request.method === "GET" && path === "/signoz/api/v1/version")
      return { body: { version } };
    if (request.method === "GET" && path === "/signoz/api/v2/rules")
      return success(state.rules);
    if (request.method === "GET" && path === "/signoz/api/v3/rules") {
      const offset = Number(parsed.searchParams.get("offset"));
      return success({
        rules: state.rules
          .slice(offset, offset + 1)
          .map(({ id, alert }) => ({ id, alert })),
        total: state.rules.length,
      });
    }
    if (request.method === "POST" && path === "/signoz/api/v2/rules/test")
      return { body: { alertCount: 2, message: "notification sent" } };
    if (request.method === "POST" && path === "/signoz/api/v2/rules") {
      const id = `01900000-0000-7000-8000-${String(++created).padStart(12, "0")}`;
      const rule = { ...request.body, id, state: "inactive" } as Rule;
      state.rules.push(rule);
      return { status: 201, body: { status: "success", data: rule } };
    }
    const index = state.rules.findIndex(
      ({ id }) => path === `/signoz/api/v2/rules/${id}`,
    );
    const rule = state.rules[index];
    if (rule === undefined)
      return { status: 404, body: { message: "not found" } };
    if (request.method === "GET") return success(rule);
    if (request.method === "PUT") {
      const saved = {
        ...structuredClone(request.body),
        id: rule.id,
        state: "inactive",
      } as Rule;
      saved.evaluation.spec.evalWindow = "5m0s";
      saved.evaluation.spec.frequency = "1m0s";
      saved.notificationSettings.renotify.interval = "4h0m0s";
      state.rules[index] = saved;
      return { status: 204 };
    }
    if (request.method === "PATCH") {
      state.rules[index] = { ...rule, ...request.body };
      return success(state.rules[index]);
    }
    return { status: 405 };
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/signoz`,
      requests,
      state,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}
