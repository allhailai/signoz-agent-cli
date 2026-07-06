import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

describe("trace inspect command", () => {
  it("resolves stored refs from the session cache", async () => {
    await withFakeSigNoz(rawRows([traceSpan()]), async ({ requests, url }) => {
      const cwd = await makeCliCwd();
      await writeSession(cwd, "trace-from-ref");
      const result = await runCli(
        ["trace", "inspect", "@t1"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        cwd,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
        compositeQuery?: {
          queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
        };
      };

      expect(
        requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
      ).toBe("trace_id = 'trace-from-ref'");
    });
  });

  it("passes full trace IDs through without a session cache", async () => {
    await withFakeSigNoz(rawRows([]), async ({ requests, url }) => {
      const result = await runCli(
        ["trace", "inspect", "full-trace-id"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
        compositeQuery?: {
          queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
        };
      };

      expect(
        requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
      ).toBe("trace_id = 'full-trace-id'");
    });
  });

  it("fails clearly when a stored ref is missing", async () => {
    const result = await runCli(["trace", "inspect", "@t1"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error trace ref @t1 not found; rerun signoz-agent traces search or pass a full trace ID\n",
    );
  });

  it("prints compact output when no spans match", async () => {
    await withFakeSigNoz(rawRows(null), async ({ url }) => {
      const result = await runCli(
        ["trace", "inspect", "trace-empty"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        "trace trace-empty spans=0 status=? method=? route=? duration=?\n",
      );
    });
  });

  it("prints compact span summaries", async () => {
    await withFakeSigNoz(
      rawRows([
        traceSpan({ durationNano: 120_000_000, spanName: "POST /checkout" }),
        traceSpan({
          durationNano: 30_000_000,
          spanName: "SELECT users",
          serviceName: "postgres",
          parentSpanId: "span-root",
        }),
      ]),
      async ({ url }) => {
        const result = await runCli(
          ["trace", "inspect", "trace-abc"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(
          "trace trace-abc spans=2 status=500 method=POST route=/checkout duration=120ms\n",
        );
        expect(result.stdout).toContain("root 120ms 500 barry POST /checkout");
        expect(result.stdout).toContain("- 30ms 500 postgres SELECT users");
      },
    );
  });

  it("prints JSON output with spans and summary", async () => {
    await withFakeSigNoz(rawRows([traceSpan()]), async ({ url }) => {
      const result = await runCli(
        ["trace", "inspect", "trace-json", "--json"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        count: number;
        query: { traceIdOrRef: string; traceId: string };
        summary: { traceId: string; spanCount: number; status: string };
        spans: Array<{ traceId: string; attributes: Record<string, unknown> }>;
      };

      expect(parsed.ok).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.query).toMatchObject({
        traceIdOrRef: "trace-json",
        traceId: "trace-json",
      });
      expect(parsed.summary).toMatchObject({
        traceId: "trace-json",
        spanCount: 1,
        status: "500",
      });
      expect(parsed.spans[0]?.attributes).toMatchObject({
        "service.name": "barry",
      });
    });
  });

  it("prints raw query_range diagnostics for trace inspect", async () => {
    await withFakeSigNoz(rawRows([traceSpan()]), async ({ url }) => {
      const result = await runCli(
        ["trace", "inspect", "trace-raw", "--raw"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        command: string;
        endpoint: string;
        request: {
          compositeQuery?: {
            queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
          };
        };
        httpStatus: number;
        responseShape: {
          status: string;
          data: { type: string };
          resultSetCount: number;
          rowCount: number;
          firstRowKeys: string[];
        };
      };

      expect(parsed).toMatchObject({
        ok: true,
        command: "trace inspect",
        endpoint: "/api/v5/query_range",
        httpStatus: 200,
        responseShape: {
          status: "success",
          data: { type: "raw" },
          resultSetCount: 1,
          rowCount: 1,
        },
      });
      expect(
        parsed.request.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
      ).toBe("trace_id = 'trace-raw'");
      expect(parsed.responseShape.firstRowKeys).toEqual([
        "data",
        "duration_nano",
        "span_id",
        "trace_id",
      ]);
    });
  });

  it("rejects combining JSON and raw diagnostics for trace inspect", async () => {
    const result = await runCli([
      "trace",
      "inspect",
      "trace-raw",
      "--json",
      "--raw",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("error Cannot combine --json and --raw\n");
  });

  it("fails clearly when SigNoz returns an error", async () => {
    await withFakeSigNoz(
      { status: "error", error: "boom" },
      async ({ url }) => {
        const result = await runCli(
          ["trace", "inspect", "trace-abc"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "error signoz trace inspect failed status=500\n",
        );
      },
      500,
    );
  });
});

describe("trace logs command", () => {
  it("resolves stored refs from the session cache", async () => {
    await withFakeSigNoz(rawRows([]), async ({ requests, url }) => {
      const cwd = await makeCliCwd();
      await writeSession(cwd, "trace-from-ref");
      const result = await runCli(
        ["trace", "logs", "@t1"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        cwd,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
        compositeQuery?: {
          queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
        };
      };

      expect(
        requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
      ).toBe("trace_id = 'trace-from-ref'");
    });
  });

  it("passes full trace IDs through without a session cache", async () => {
    await withFakeSigNoz(rawRows([]), async ({ requests, url }) => {
      const result = await runCli(
        ["trace", "logs", "full-trace-id"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
        compositeQuery?: {
          queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
        };
      };

      expect(
        requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
      ).toBe("trace_id = 'full-trace-id'");
    });
  });

  it("fails clearly when a stored ref is missing", async () => {
    const result = await runCli(["trace", "logs", "@t1"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error trace ref @t1 not found; rerun signoz-agent traces search or pass a full trace ID\n",
    );
  });

  it("prints compact output when no logs match", async () => {
    await withFakeSigNoz(rawRows(null), async ({ url }) => {
      const result = await runCli(
        ["trace", "logs", "trace-empty"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        [
          "0 logs for trace=trace-empty",
          "",
          "No logs with trace_id matched this trace in the selected time window.",
          "The service may emit related logs without trace correlation.",
          "",
          "Next:",
          "- signoz-agent logs search --filter \"trace_id = 'trace-empty'\"",
          '- signoz-agent logs search --contains "<known task id or message>"',
          "- signoz-agent trace inspect trace-empty --json",
          "",
        ].join("\n"),
      );
    });
  });

  it("prints compact log rows", async () => {
    await withFakeSigNoz(
      rawRows([
        logRow({
          timestamp: "2026-07-03T12:00:00Z",
          level: "ERROR",
          message: "webhook failed",
        }),
      ]),
      async ({ url }) => {
        const result = await runCli(
          ["trace", "logs", "trace-abc"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(
          "1 logs for trace=trace-abc\n2026-07-03T12:00:00Z ERROR webhook failed\n",
        );
      },
    );
  });

  it("prints JSON output with attributes", async () => {
    await withFakeSigNoz(
      rawRows([
        logRow({
          timestamp: "2026-07-03T12:00:00Z",
          level: "ERROR",
          message: "webhook failed",
        }),
      ]),
      async ({ url }) => {
        const result = await runCli(
          ["trace", "logs", "trace-json", "--json"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");

        const parsed = JSON.parse(result.stdout) as {
          ok: boolean;
          count: number;
          query: { traceIdOrRef: string; traceId: string };
          logs: Array<{ message: string; attributes: Record<string, unknown> }>;
        };

        expect(parsed.ok).toBe(true);
        expect(parsed.count).toBe(1);
        expect(parsed.query).toMatchObject({
          traceIdOrRef: "trace-json",
          traceId: "trace-json",
        });
        expect(parsed.logs[0]).toMatchObject({
          message: "webhook failed",
          attributes: {
            trace_id: "trace-abc",
            component: "worker",
          },
        });
      },
    );
  });

  it("prints raw query_range diagnostics for trace logs", async () => {
    await withFakeSigNoz(
      rawRows([
        logRow({
          timestamp: "2026-07-03T12:00:00Z",
          level: "ERROR",
          message: "webhook failed",
        }),
      ]),
      async ({ url }) => {
        const result = await runCli(
          ["trace", "logs", "trace-logs-raw", "--raw"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");

        const parsed = JSON.parse(result.stdout) as {
          ok: boolean;
          command: string;
          endpoint: string;
          request: {
            compositeQuery?: {
              queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
            };
          };
          httpStatus: number;
          responseShape: {
            status: string;
            data: { type: string };
            resultSetCount: number;
            rowCount: number;
            firstRowKeys: string[];
          };
        };

        expect(parsed).toMatchObject({
          ok: true,
          command: "trace logs",
          endpoint: "/api/v5/query_range",
          httpStatus: 200,
          responseShape: {
            status: "success",
            data: { type: "raw" },
            resultSetCount: 1,
            rowCount: 1,
          },
        });
        expect(
          parsed.request.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
        ).toBe("trace_id = 'trace-logs-raw'");
        expect(parsed.responseShape.firstRowKeys).toEqual([
          "attributes",
          "body",
          "severity_text",
          "timestamp",
        ]);
      },
    );
  });

  it("fails clearly when SigNoz returns an error", async () => {
    await withFakeSigNoz(
      { status: "error", error: "boom" },
      async ({ url }) => {
        const result = await runCli(
          ["trace", "logs", "trace-abc"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "error signoz trace logs failed status=500\n",
        );
      },
      500,
    );
  });
});

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = cliEnv(),
  cwd?: string,
): Promise<CliResult> {
  const cliCwd = cwd ?? (await makeCliCwd());

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      {
        cwd: cliCwd,
        env,
      },
    );

    return {
      exitCode: 0,
      stdout,
      stderr,
      cwd: cliCwd,
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
      cwd: cliCwd,
    };
  }
}

function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
  };
}

async function makeCliCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "signoz-agent-trace-test-"));
}

async function writeSession(cwd: string, traceId: string): Promise<void> {
  const directory = join(cwd, ".signoz-agent");

  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "session.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-07-03T00:00:00.000Z",
      traces: [{ ref: "@t1", traceId }],
    })}\n`,
    "utf8",
  );
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

function traceSpan(
  options: {
    durationNano?: number;
    spanName?: string;
    serviceName?: string;
    parentSpanId?: string;
  } = {},
): unknown {
  return {
    trace_id: "trace-abc",
    span_id: options.parentSpanId === undefined ? "span-root" : "span-child",
    ...(options.parentSpanId === undefined
      ? {}
      : { parent_span_id: options.parentSpanId }),
    duration_nano: options.durationNano ?? 120_000_000,
    data: {
      name: options.spanName ?? "POST /checkout",
      attributes: {
        "service.name": options.serviceName ?? "barry",
        "http.request.method": "POST",
        "http.response.status_code": 500,
        "http.route": "/checkout",
      },
    },
  };
}

function logRow(options: {
  timestamp: string;
  level: string;
  message: string;
}): unknown {
  return {
    timestamp: options.timestamp,
    severity_text: options.level,
    body: options.message,
    attributes: {
      trace_id: "trace-abc",
      component: "worker",
    },
  };
}
