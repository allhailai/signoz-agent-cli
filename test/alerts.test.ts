import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type Request = {
  method: string | undefined;
  url: string | undefined;
  apiKey: string | string[] | undefined;
  body: Record<string, unknown>;
};
type Reply = {
  status?: number;
  body?: unknown;
  disconnect?: boolean;
  contentType?: string;
  bodyText?: string;
};
type CliResult = { exitCode: number; stdout: string; stderr: string };

const ruleId = "01900000-0000-7000-8000-000000000001";
const rulePath = `/signoz/api/v2/rules/${ruleId}`;
const filter = "deployment.environment = 'production' AND status_code = 2";

function ruleFixture() {
  return {
    id: ruleId,
    alert: "Production error spans",
    state: "inactive",
    disabled: false,
    alertType: "TRACES_BASED_ALERT",
    ruleType: "threshold_rule",
    schemaVersion: "v2alpha1",
    labels: { team: "platform" },
    condition: {
      compositeQuery: {
        queryType: "builder",
        panelType: "graph",
        queries: [
          {
            type: "builder_query",
            spec: {
              name: "A",
              signal: "traces",
              filter: { expression: filter },
              aggregations: [{ expression: "count_distinct(trace_id)" }],
            },
          },
          {
            type: "builder_query",
            spec: {
              name: "B",
              signal: "traces",
              filter: { expression: "status_code = 2" },
              aggregations: [{ expression: "count()" }],
            },
          },
          { type: "builder_formula", spec: { name: "F1", expression: "A/B" } },
        ],
      },
      selectedQueryName: "F1",
      thresholds: {
        kind: "basic",
        spec: [
          {
            name: "warning",
            target: 0,
            op: "above",
            matchType: "at_least_once",
            channels: ["oncall"],
            recoveryTarget: null,
          },
        ],
      },
    },
    evaluation: {
      kind: "rolling",
      spec: { evalWindow: "5m0s", frequency: "1m0s" },
    },
    notificationSettings: {
      usePolicy: false,
      renotify: { enabled: true, interval: "4h0m0s" },
    },
    futureField: { preserve: true },
  };
}

describe("alert rules commands", () => {
  it("discovers inactive and disabled rules across pages using authenticated GETs", async () => {
    const rules = [
      ruleFixture(),
      {
        ...ruleFixture(),
        id: "disabled-rule",
        disabled: true,
        state: "disabled",
      },
      { ...ruleFixture(), id: "third-rule", state: "firing" },
    ];
    await withFakeSigNoz(
      (request) => {
        if (request.url === "/signoz/api/v1/version")
          return { body: { version: "v0.144.0" } };
        const url = new URL(request.url ?? "", "http://localhost");
        const offset = Number(url.searchParams.get("offset"));
        return success({ rules: rules.slice(offset, offset + 2), total: 3 });
      },
      async ({ url, requests }) => {
        const first = await runCli(url, [
          "alerts",
          "list",
          "--limit",
          "2",
          "--json",
        ]);
        expect(first.exitCode).toBe(0);
        expect(JSON.parse(first.stdout)).toMatchObject({
          count: 2,
          total: 3,
          nextOffset: 2,
          rules: [{ state: "inactive" }, { state: "disabled", disabled: true }],
        });
        const second = await runCli(url, [
          "alerts",
          "list",
          "--limit",
          "2",
          "--offset",
          "2",
          "--json",
        ]);
        expect(JSON.parse(second.stdout)).toMatchObject({
          count: 1,
          total: 3,
          nextOffset: null,
          rules: [{ id: "third-rule" }],
        });
        expect(
          requests.map((request) => [
            request.method,
            request.url,
            request.apiKey,
          ]),
        ).toEqual([
          ["GET", "/signoz/api/v1/version", undefined],
          ["GET", "/signoz/api/v3/rules?limit=2&offset=0", "test-secret"],
          ["GET", "/signoz/api/v1/version", undefined],
          ["GET", "/signoz/api/v3/rules?limit=2&offset=2", "test-secret"],
        ]);
        const text = await runCli(url, ["alerts", "list", "--limit", "2"]);
        expect(text.stdout).toContain("--offset 2");
        expect(text.stdout).toContain("disabled-rule");
      },
    );
  });

  it.each([401, 403, 404, 405, 500, 200])(
    "reports failed or malformed v3 responses without extra requests or credential exposure (%s)",
    async (status) => {
      await withFakeSigNoz(
        () => ({ status, body: { status: "error", message: "test-secret" } }),
        async ({ url, requests }) => {
          const result = await runCli(url, ["alerts", "list", "--json"]);
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe("");
          expect(JSON.parse(result.stderr)).toMatchObject({
            ok: false,
            code: status === 200 ? "unexpected_response" : "signoz_error",
          });
          expect(result.stderr).not.toContain("test-secret");
          expect(requests.map((request) => request.url)).toEqual([
            "/signoz/api/v1/version",
            "/signoz/api/v3/rules?limit=20&offset=0",
          ]);
        },
      );
    },
  );

  it("pages v0.141.1 full rules locally and preserves summaries and text", async () => {
    const fullRules = [
      ruleFixture(),
      { ...ruleFixture(), id: "disabled-rule", disabled: true },
    ];
    const rules = [
      ...fullRules,
      { id: "minimal-rule", alert: "No optional fields" },
    ];
    await withFakeSigNoz(
      (request) => {
        if (request.url === "/signoz/api/v1/version")
          return {
            body: { version: "v0.141.1", ee: "Y", setupCompleted: true },
          };
        if (request.url === "/signoz/api/v2/rules") return success(rules);
        // Observed on v0.141.1: unsupported API routes serve the SPA with HTTP 200.
        return {
          status: 200,
          contentType: "text/html; charset=utf-8",
          bodyText: "<!doctype html><html>SigNoz</html>",
        };
      },
      async ({ url, requests }) => {
        for (const offset of [0, 2, 3, 10]) {
          const result = await runCli(url, [
            "alerts",
            "list",
            "--limit",
            "2",
            "--offset",
            String(offset),
            "--json",
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe("");
          const expectedRules =
            offset === 0
              ? fullRules.map(
                  ({
                    id,
                    alert,
                    state,
                    disabled,
                    alertType,
                    ruleType,
                    labels,
                  }) => ({
                    id,
                    alert,
                    state,
                    disabled,
                    alertType,
                    ruleType,
                    labels,
                  }),
                )
              : rules.slice(offset);
          expect(JSON.parse(result.stdout)).toEqual({
            ok: true,
            count: expectedRules.length,
            total: 3,
            nextOffset: offset === 0 ? 2 : null,
            query: { limit: 2, offset },
            rules: expectedRules,
          });
        }
        const text = await runCli(url, ["alerts", "list", "--limit", "2"]);
        expect(text.exitCode).toBe(0);
        expect(text.stdout).toContain("2 alert rules total=3 offset=0");
        expect(text.stdout).toContain(
          'disabled-rule "Production error spans" state=inactive disabled=true',
        );
        expect(text.stdout).toContain("--offset 2");
        expect(
          requests.map(({ method, url, apiKey }) => [method, url, apiKey]),
        ).toEqual(
          Array.from({ length: 5 }, () => [
            ["GET", "/signoz/api/v1/version", undefined],
            ["GET", "/signoz/api/v2/rules", "test-secret"],
          ]).flat(),
        );
      },
    );
  });

  it.each([
    ["0.143.9", "v2"],
    ["v0.144.0-rc.1", "v2"],
    ["0.144.0+build.1", "v3"],
    ["v0.144.1", "v3"],
    ["v0.150.0", "v3"],
    ["v1.0.0", "v3"],
    ["v0.141", "v3"],
    ["v0.0141.1", "v3"],
    ["v0.141.1-01", "v3"],
    ["v0.141.1-garbage!", "v3"],
    ["test-secret", "v3"],
  ])(
    "selects %s's %s list API using semantic versions",
    async (version, tier) => {
      await withFakeSigNoz(
        (request) =>
          request.url === "/signoz/api/v1/version"
            ? { body: { version } }
            : success(tier === "v2" ? [] : { rules: [], total: 0 }),
        async ({ url, requests }) => {
          const result = await runCli(url, ["alerts", "list", "--json"]);
          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout)).toMatchObject({
            count: 0,
            total: 0,
            nextOffset: null,
            rules: [],
          });
          expect(requests.map((request) => request.url)).toEqual([
            "/signoz/api/v1/version",
            tier === "v2"
              ? "/signoz/api/v2/rules"
              : "/signoz/api/v3/rules?limit=20&offset=0",
          ]);
        },
      );
    },
  );

  it.each<Reply>([
    {
      status: 200,
      contentType: "text/html",
      bodyText: "<html>test-secret</html>",
    },
    { status: 404, body: { message: "test-secret" } },
    { disconnect: true },
  ])("attempts v3 when version discovery fails (%j)", async (versionReply) => {
    await withFakeSigNoz(
      (request) =>
        request.url === "/signoz/api/v1/version"
          ? versionReply
          : {
              status: 200,
              contentType: "text/html",
              bodyText: "<html>test-secret</html>",
            },
      async ({ url, requests }) => {
        const result = await runCli(url, ["alerts", "list", "--json"]);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stderr)).toEqual({
          ok: false,
          command: "alerts list",
          code: "unexpected_response",
          message: "SigNoz returned an unexpected alert rule response",
          endpoint: "/api/v3/rules?limit=20&offset=0",
        });
        expect(requests.map((request) => request.url)).toEqual([
          "/signoz/api/v1/version",
          "/signoz/api/v3/rules?limit=20&offset=0",
        ]);
      },
    );
  });

  it.each([401, 403, 404, 500, 200])(
    "reports failed or malformed v2 responses (%s)",
    async (status) => {
      await withFakeSigNoz(
        (request) =>
          request.url === "/signoz/api/v1/version"
            ? { body: { version: "v0.141.1" } }
            : {
                status,
                body: { status: "success", data: { message: "test-secret" } },
              },
        async ({ url, requests }) => {
          const result = await runCli(url, ["alerts", "list", "--json"]);
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe("");
          expect(JSON.parse(result.stderr)).toMatchObject({
            ok: false,
            code: status === 200 ? "unexpected_response" : "signoz_error",
            endpoint: "/api/v2/rules",
            ...(status === 200 ? {} : { httpStatus: status }),
          });
          expect(requests.map((request) => request.url)).toEqual([
            "/signoz/api/v1/version",
            "/signoz/api/v2/rules",
          ]);
        },
      );
    },
  );

  it.each(["v1", "v2alpha1"])(
    "retains the complete definition and unfamiliar fields for %s rules",
    async (schemaVersion) => {
      const rule = {
        ...ruleFixture(),
        schemaVersion,
        condition:
          schemaVersion === "v1"
            ? {
                compositeQuery: ruleFixture().condition.compositeQuery,
                target: 0,
                op: "1",
              }
            : ruleFixture().condition,
      };
      await withFakeSigNoz(
        () => success(rule),
        async ({ url }) => {
          const result = await runCli(url, [
            "alerts",
            "inspect",
            ruleId,
            "--json",
          ]);
          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout).rule).toEqual(rule);
          const text = await runCli(url, ["alerts", "inspect", ruleId]);
          expect(text.stdout).toContain(filter);
          expect(text.stdout).toContain("A/B");
        },
      );
    },
  );

  it("previews array replacements and removed queries without issuing a write", async () => {
    const rule = ruleFixture();
    const queries = rule.condition.compositeQuery.queries.slice(0, 1);
    const patch = { condition: { compositeQuery: { queries } } };
    await withFakeSigNoz(
      () => success(rule),
      async ({ url, requests }) => {
        const result = await runCli(
          url,
          [
            "alerts",
            "update",
            ruleId,
            "--patch-file",
            "-",
            "--dry-run",
            "--json",
          ],
          JSON.stringify(patch),
        );
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          dryRun: true,
          verified: false,
          changes: [
            {
              path: "/condition/compositeQuery/queries",
              before: rule.condition.compositeQuery.queries,
              after: queries,
            },
          ],
        });
        expect(requests.map((request) => request.method)).toEqual(["GET"]);
      },
    );
  });

  it("preserves sibling queries, thresholds, evaluation fields, and routing when saving a filter edit", async () => {
    const original = ruleFixture();
    let stored: Record<string, unknown> = structuredClone(original);
    const queries = structuredClone(original.condition.compositeQuery.queries);
    queries[0]!.spec.filter = {
      expression: `${filter} AND error.type != 'expected_retry'`,
    };
    const patch = {
      condition: { compositeQuery: { queries } },
      evaluation: { spec: { frequency: "2m" } },
    };
    await withFakeSigNoz(
      (request) => {
        if (request.method === "PATCH") {
          // Model replacement of object envelopes, rather than a recursive merge.
          stored = { ...stored, ...request.body };
          const evaluation = stored.evaluation as typeof original.evaluation;
          evaluation.spec.frequency = "2m0s";
        }
        return success(stored);
      },
      async ({ url, requests }) => {
        const result = await runCli(
          url,
          ["alerts", "update", ruleId, "--patch-file", "-", "--json"],
          JSON.stringify(patch),
        );
        expect(result.exitCode).toBe(0);
        const saved = JSON.parse(result.stdout).rule;
        expect(saved.condition.compositeQuery.queries).toEqual(queries);
        expect(saved.condition.thresholds).toEqual(
          original.condition.thresholds,
        );
        expect(saved.condition.selectedQueryName).toBe("F1");
        expect(saved.evaluation).toEqual({
          kind: "rolling",
          spec: { evalWindow: "5m0s", frequency: "2m0s" },
        });
        expect(saved.notificationSettings).toEqual(
          original.notificationSettings,
        );
        expect(saved.futureField).toEqual(original.futureField);
        expect(
          requests.map((request) => [request.method, request.url]),
        ).toEqual([
          ["GET", rulePath],
          ["PATCH", rulePath],
          ["GET", rulePath],
        ]);
        expect(Object.keys(requests[1]!.body).sort()).toEqual([
          "condition",
          "evaluation",
        ]);
        expect(JSON.parse(result.stdout)).toMatchObject({
          dryRun: false,
          verified: true,
        });
      },
    );
  });

  it("verifies cleared optional fields from a file and avoids writing them again", async () => {
    const rule = ruleFixture();
    const original = {
      ...rule,
      description: "Old description",
      condition: {
        ...rule.condition,
        thresholds: {
          ...rule.condition.thresholds,
          spec: [{ ...rule.condition.thresholds.spec[0], recoveryTarget: 5 }],
        },
      },
    };
    let stored: Record<string, unknown> = original;
    const patch = {
      description: "",
      labels: null,
      condition: {
        thresholds: {
          spec: [
            { ...original.condition.thresholds.spec[0], recoveryTarget: null },
          ],
        },
      },
    };
    const directory = await mkdtemp(join(tmpdir(), "signoz-alert-patch-"));
    const file = join(directory, "change.json");
    await writeFile(file, JSON.stringify(patch));
    try {
      await withFakeSigNoz(
        (request) => {
          if (request.method === "PATCH") {
            stored = { ...stored, ...request.body };
            delete stored.description;
            delete stored.labels;
            const condition = stored.condition as {
              thresholds: { spec: Array<Record<string, unknown>> };
            };
            delete condition.thresholds.spec[0]!.recoveryTarget;
          }
          return success(stored);
        },
        async ({ url, requests }) => {
          const result = await runCli(url, [
            "alerts",
            "update",
            ruleId,
            "--patch-file",
            file,
            "--json",
          ]);
          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout)).toMatchObject({ verified: true });
          expect(JSON.parse(result.stdout).rule).not.toHaveProperty(
            "description",
          );
          const repeated = await runCli(url, [
            "alerts",
            "update",
            ruleId,
            "--patch-file",
            file,
            "--json",
          ]);
          expect(repeated.exitCode).toBe(0);
          expect(JSON.parse(repeated.stdout).changes).toEqual([]);
          expect(
            requests.filter((request) => request.method === "PATCH"),
          ).toHaveLength(1);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["{", "[]", "{}", '{"ok":true,"rule":{}}', '{"id":"another-rule"}'])(
    "rejects invalid patch input before contacting SigNoz (%s)",
    async (patch) => {
      await withFakeSigNoz(
        () => success(ruleFixture()),
        async ({ url, requests }) => {
          const result = await runCli(
            url,
            ["alerts", "update", ruleId, "--patch-file", "-", "--json"],
            patch,
          );
          expect(result.exitCode).toBe(1);
          expect(JSON.parse(result.stderr)).toMatchObject({
            code: "invalid_patch",
          });
          expect(requests).toHaveLength(0);
        },
      );
    },
  );

  it.each(["ignored", "readback-failed", "disconnect", "rejected"])(
    "reports unverified writes without retrying (%s)",
    async (mode) => {
      let reads = 0;
      await withFakeSigNoz(
        (request) => {
          if (request.method === "PATCH") {
            if (mode === "disconnect") return { disconnect: true };
            if (mode === "rejected")
              return { status: 400, body: { message: "test-secret" } };
          } else if (++reads > 1 && mode === "readback-failed") {
            return { status: 503 };
          }
          return success(ruleFixture());
        },
        async ({ url, requests }) => {
          const result = await runCli(
            url,
            ["alerts", "update", ruleId, "--patch-file", "-", "--json"],
            '{"alert":"New rule name"}',
          );
          expect(result.exitCode).toBe(1);
          const code =
            mode === "disconnect"
              ? "update_unconfirmed"
              : mode === "rejected"
                ? "signoz_error"
                : "verification_failed";
          expect(JSON.parse(result.stderr)).toMatchObject({ code });
          if (mode !== "rejected") {
            expect(JSON.parse(result.stderr).writeStatus).toBe(
              mode === "disconnect" ? "unknown" : "accepted",
            );
          }
          expect(result.stderr).not.toContain("test-secret");
          expect(
            requests.filter((request) => request.method === "PATCH"),
          ).toHaveLength(1);
        },
      );
    },
  );
});

function success(data: unknown): Reply {
  return { body: { status: "success", data } };
}

async function runCli(
  url: string,
  args: string[],
  input = "",
): Promise<CliResult> {
  const result = await runCliUnchecked(url, args, input);
  expect(result.stdout).not.toContain("test-secret");
  expect(result.stderr).not.toContain("test-secret");
  return result;
}

function runCliUnchecked(
  url: string,
  args: string[],
  input: string,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(process.cwd(), "dist", "cli.js"), ...args],
      {
        env: {
          ...process.env,
          SIGNOZ_API_URL: url,
          SIGNOZ_API_KEY: "test-secret",
        },
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.end(input);
  });
}

async function withFakeSigNoz(
  respond: (request: Request) => Reply,
  test: (context: { url: string; requests: Request[] }) => Promise<void>,
): Promise<void> {
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const captured = {
        method: request.method,
        url: request.url,
        apiKey: request.headers["signoz-api-key"],
        body,
      };
      requests.push(captured);
      const reply = respond(captured);
      if (reply.disconnect === true) {
        request.socket.destroy();
        return;
      }
      response.writeHead(reply.status ?? 200, {
        "content-type": reply.contentType ?? "application/json",
      });
      response.end(reply.bodyText ?? JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await test({ url: `http://127.0.0.1:${address.port}/signoz`, requests });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  }
}

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}
