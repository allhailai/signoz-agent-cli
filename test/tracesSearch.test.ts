import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "dist", "cli.js");

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  cwd: string;
};

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  apiKey: string | string[] | undefined;
  body: string;
};

describe("traces search command", () => {
  it("fails with next steps when no service is selected", async () => {
    const result = await runCli(["traces", "search"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "error no service selected",
        "Next:",
        "- signoz-agent services list --since 2h",
        "- signoz-agent services select <service-name>",
        "- signoz-agent traces search --service <service-name>",
        '- signoz-agent traces search --filter "<expr>"',
        "",
      ].join("\n"),
    );

    await rm(result.cwd, { recursive: true, force: true });
  });

  it("prints compact output and writes an empty ref cache when no rows match", async () => {
    await withFakeSigNoz(rawRows([]), async ({ url }) => {
      const result = await runCli(
        ["traces", "search", "--service", "barry", "--since", "30m"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "0 matching traces for service=barry since=30m\n",
      );
      expect(result.stdout).toContain("- widen --since or relax filters\n");
      await expect(readSession(result.cwd)).resolves.toMatchObject({
        version: 1,
        traces: [],
      });
    });
  });

  it("treats SigNoz rows null as an empty successful result", async () => {
    await withFakeSigNoz(rawRows(null), async ({ url }) => {
      const result = await runCli(
        ["traces", "search", "--service", "barry", "--since", "30m"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "0 matching traces for service=barry since=30m\n",
      );
      await expect(readSession(result.cwd)).resolves.toMatchObject({
        version: 1,
        traces: [],
      });
    });
  });

  it("prints compact trace refs for one matching row", async () => {
    await withFakeSigNoz(
      rawRows([
        traceRow({
          traceId: "abcdef1234567890abcdef1234567890",
          statusCode: 401,
          method: "POST",
          route: "/webhooks/signoz",
          durationNano: 12_300_000,
        }),
      ]),
      async ({ requests, url }) => {
        const result = await runCli(
          [
            "traces",
            "search",
            "--service",
            "barry",
            "--route",
            "/webhooks/signoz",
            "--status",
            ">=400",
            "--min-duration",
            "10",
            "--since",
            "30m",
            "--limit",
            "3",
          ],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(
          "1 matching trace for service=barry route=/webhooks/signoz since=30m",
        );
        expect(result.stdout).toContain(
          "@t1 401 POST /webhooks/signoz 12ms trace=abcdef123456...",
        );
        expect(result.stdout).toContain("- signoz-agent trace inspect @t1\n");

        const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
          compositeQuery?: {
            queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
          };
        };

        expect(
          requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
        ).toBe(
          "service.name = 'barry' AND http.route = '/webhooks/signoz' AND http.response.status_code >= 400 AND duration_nano >= 10000000",
        );
        await expect(readSession(result.cwd)).resolves.toMatchObject({
          traces: [
            {
              ref: "@t1",
              traceId: "abcdef1234567890abcdef1234567890",
              serviceName: "barry",
              method: "POST",
              route: "/webhooks/signoz",
              statusCode: 401,
              durationMs: 12,
            },
          ],
        });
      },
    );
  });

  it("assigns stable refs for multiple rows", async () => {
    await withFakeSigNoz(
      rawRows([
        traceRow({
          traceId: "trace-one",
          statusCode: 401,
          method: "POST",
          route: "/webhooks/signoz",
          durationNano: 10_000_000,
        }),
        traceRow({
          traceId: "trace-two",
          statusCode: 502,
          method: "POST",
          route: "/webhooks/signoz",
          durationNano: 811_000_000,
        }),
      ]),
      async ({ url }) => {
        const result = await runCli(
          [
            "traces",
            "search",
            "--service",
            "barry",
            "--route",
            "/webhooks/signoz",
          ],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
          "@t1 401 POST /webhooks/signoz 10ms trace=trace-one",
        );
        expect(result.stdout).toContain(
          "@t2 502 POST /webhooks/signoz 811ms trace=trace-two",
        );
      },
    );
  });

  it("prints JSON with full trace IDs and metadata", async () => {
    await withFakeSigNoz(
      rawRows([
        {
          data: {
            attributes: {
              "service.name": "barry",
              "http.request.method": "POST",
              "http.response.status_code": "502",
              "http.route": "/webhooks/signoz",
            },
            links: [{ traceId: "fedcba9876543210fedcba9876543210" }],
            name: "POST /webhooks/signoz",
          },
          duration_nano: "811000000",
        },
      ]),
      async ({ url }) => {
        const result = await runCli(
          ["traces", "search", "--service", "barry", "--json"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");

        const parsed = JSON.parse(result.stdout) as {
          ok: boolean;
          count: number;
          query: unknown;
          traces: Array<{
            ref: string;
            traceId: string;
            statusCode: number;
            durationMs: number;
            spanName: string;
            attributes: Record<string, unknown>;
          }>;
        };

        expect(parsed.ok).toBe(true);
        expect(parsed.count).toBe(1);
        expect(parsed.query).toMatchObject({
          serviceName: "barry",
          since: "30m",
          limit: 20,
        });
        expect(parsed.query).not.toHaveProperty("statusExpression");
        expect(parsed.traces[0]).toMatchObject({
          ref: "@t1",
          traceId: "fedcba9876543210fedcba9876543210",
          statusCode: 502,
          durationMs: 811,
          spanName: "POST /webhooks/signoz",
          attributes: {
            "service.name": "barry",
            "http.request.method": "POST",
            "http.response.status_code": "502",
            "http.route": "/webhooks/signoz",
          },
        });
      },
    );
  });

  it("searches traces by direct SigNoz filter without requiring service", async () => {
    await withFakeSigNoz(rawRows([]), async ({ requests, url }) => {
      const result = await runCli(
        [
          "traces",
          "search",
          "--filter",
          "barry.agent_run_id = '4'",
          "--since",
          "2h",
        ],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "0 matching traces for filter=barry.agent_run_id = '4' since=2h\n",
      );

      const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
        compositeQuery?: {
          queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
        };
      };

      expect(
        requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
      ).toBe("barry.agent_run_id = '4'");

      await expect(readSession(result.cwd)).resolves.toMatchObject({
        version: 1,
        traces: [],
      });
    });
  });

  it("does not add a hidden failed-status filter for service searches", async () => {
    await withFakeSigNoz(rawRows([]), async ({ requests, url }) => {
      const result = await runCli(
        ["traces", "search", "--service", "opencode-agent", "--since", "2h"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);

      const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
        compositeQuery?: {
          queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
        };
      };

      expect(
        requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
      ).toBe("service.name = 'opencode-agent'");

      await expect(readSession(result.cwd)).resolves.toMatchObject({
        version: 1,
        traces: [],
      });
    });
  });

  it("uses the selected service when no service or filter is provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "signoz-agent-test-"));

    try {
      await writeSession(cwd, {
        version: 1,
        updatedAt: "2026-07-06T07:00:00.000Z",
        traces: [],
        currentService: "control-tower-api",
      });

      await withFakeSigNoz(rawRows([]), async ({ requests, url }) => {
        const result = await runCliInCwd(
          ["traces", "search", "--since", "30m"],
          cwd,
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(
          "0 matching traces for service=control-tower-api since=30m\n",
        );

        const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
          compositeQuery?: {
            queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
          };
        };

        expect(
          requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
        ).toBe("service.name = 'control-tower-api'");
        await expect(readSession(cwd)).resolves.toMatchObject({
          currentService: "control-tower-api",
          traces: [],
        });
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects combining direct filters with structured filters", async () => {
    const result = await runCli([
      "traces",
      "search",
      "--filter",
      "barry.agent_run_id = '4'",
      "--service",
      "barry",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error Cannot combine --filter with --service, --route, --status, or --min-duration\n",
    );

    await rm(result.cwd, { recursive: true, force: true });
  });

  it("fails clearly when SigNoz returns an error", async () => {
    await withFakeSigNoz(
      { status: "error", error: "boom" },
      async ({ url }) => {
        const result = await runCli(
          ["traces", "search", "--service", "barry"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "error signoz trace search failed status=500\n",
        );
      },
      500,
    );
  });

  it("fails clearly on unexpected successful response shapes", async () => {
    await withFakeSigNoz(
      { status: "success", data: { type: "aggregate" } },
      async ({ url }) => {
        const result = await runCli(
          ["traces", "search", "--service", "barry"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "error signoz trace search unexpected response: SigNoz query_range did not return raw data\n",
        );
      },
    );
  });
});

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = cliEnv(),
): Promise<CliResult> {
  const cwd = await mkdtemp(join(tmpdir(), "signoz-agent-test-"));

  return runCliInCwd(args, cwd, env);
}

async function runCliInCwd(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = cliEnv(),
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      {
        cwd,
        env,
      },
    );

    return {
      exitCode: 0,
      stdout,
      stderr,
      cwd,
    };
  } catch (error) {
    const execError = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };

    return {
      exitCode: typeof execError.code === "number" ? execError.code : 1,
      stdout: typeof execError.stdout === "string" ? execError.stdout : "",
      stderr: typeof execError.stderr === "string" ? execError.stderr : "",
      cwd,
    };
  }
}

function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
  };
}

async function withFakeSigNoz(
  responseBody: unknown,
  testFn: (context: {
    requests: CapturedRequest[];
    url: string;
  }) => Promise<void>,
  statusCode = 200,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    readBody(request).then((body) => {
      requests.push({
        method: request.method,
        url: request.url,
        apiKey: request.headers["signoz-api-key"],
        body,
      });

      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  try {
    await testFn({ requests, url });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
          return;
        }

        reject(error);
      });
    });
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function rawRows(rows: unknown[] | null): unknown {
  return {
    status: "success",
    data: {
      type: "raw",
      data: {
        results: [
          {
            queryName: "A",
            nextCursor: null,
            rows,
          },
        ],
      },
    },
  };
}

function traceRow(options: {
  traceId: string;
  statusCode: number;
  method: string;
  route: string;
  durationNano: number;
}): unknown {
  return {
    trace_id: options.traceId,
    duration_nano: options.durationNano,
    data: {
      attributes: {
        "service.name": "barry",
        "http.request.method": options.method,
        "http.response.status_code": options.statusCode,
        "http.route": options.route,
      },
    },
  };
}

async function readSession(cwd: string): Promise<unknown> {
  const text = await readFile(
    join(cwd, ".signoz-agent", "session.json"),
    "utf8",
  );

  await rm(cwd, { recursive: true, force: true });

  return JSON.parse(text) as unknown;
}

async function writeSession(cwd: string, session: unknown): Promise<void> {
  await mkdir(join(cwd, ".signoz-agent"), { recursive: true });
  await writeFile(
    join(cwd, ".signoz-agent", "session.json"),
    `${JSON.stringify(session, null, 2)}\n`,
    "utf8",
  );
}
