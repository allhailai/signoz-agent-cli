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

describe("services command", () => {
  it("lists services from recent trace rows", async () => {
    await withFakeSigNoz(
      rawRows([
        traceRow({
          traceId: "trace-one",
          serviceName: "control-tower-api",
          statusCode: 200,
          timestamp: "2026-07-06T07:00:00Z",
        }),
        traceRow({
          traceId: "trace-two",
          serviceName: "control-tower-api",
          statusCode: 500,
          timestamp: "2026-07-06T07:05:00Z",
        }),
        traceRow({
          traceId: "trace-two",
          serviceName: "control-tower-api",
          statusCode: 500,
          timestamp: "2026-07-06T07:05:00Z",
        }),
        traceRow({
          traceId: "trace-three",
          serviceName: "barry",
          statusCode: 200,
          timestamp: "2026-07-06T06:30:00Z",
        }),
        traceRow({
          traceId: "trace-four",
          serviceName: "worker",
          statusCode: 200,
        }),
      ]),
      async ({ requests, url }) => {
        const result = await runCli(
          ["services", "list", "--since", "2h", "--limit", "3"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("3 services since=2h\n");
        expect(result.stdout).toContain(
          "control-tower-api traces=2 errors=1 latest=2026-07-06T07:05:00Z\n",
        );
        expect(result.stdout).toContain(
          "barry traces=1 errors=0 latest=2026-07-06T06:30:00Z\n",
        );
        expect(result.stdout).toContain("worker traces=1 errors=0 latest=?\n");
        expect(result.stdout).toContain(
          "- signoz-agent services select control-tower-api\n",
        );

        const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
          compositeQuery?: {
            queries?: Array<{
              spec?: { filter?: { expression?: string }; limit?: number };
            }>;
          };
        };

        expect(requests[0]?.method).toBe("POST");
        expect(requests[0]?.url).toBe("/api/v5/query_range");
        expect(requests[0]?.apiKey).toBe("test-secret");
        expect(
          requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
        ).toBe("service.name != ''");
        expect(requestBody.compositeQuery?.queries?.[0]?.spec?.limit).toBe(60);

        await rm(result.cwd, { recursive: true, force: true });
      },
    );
  });

  it("prints JSON service summaries when requested", async () => {
    await withFakeSigNoz(
      rawRows([
        traceRow({
          traceId: "trace-one",
          serviceName: "control-tower-api",
          statusCode: 500,
          timestamp: "2026-07-06T07:05:00Z",
        }),
      ]),
      async ({ url }) => {
        const result = await runCli(
          ["services", "list", "--json"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");

        const parsed = JSON.parse(result.stdout) as {
          ok: boolean;
          count: number;
          query: { since: string; limit: number };
          services: Array<{
            serviceName: string;
            traceCount: number;
            errorCount: number;
            latestTimestamp: string;
          }>;
        };

        expect(parsed).toMatchObject({
          ok: true,
          count: 1,
          query: {
            since: "2h",
            limit: 20,
          },
          services: [
            {
              serviceName: "control-tower-api",
              traceCount: 1,
              errorCount: 1,
              latestTimestamp: "2026-07-06T07:05:00Z",
            },
          ],
        });

        await rm(result.cwd, { recursive: true, force: true });
      },
    );
  });

  it("prints raw query_range diagnostics without summarizing services", async () => {
    await withFakeSigNoz(
      rawRows([
        traceRow({
          traceId: "trace-one",
          serviceName: "control-tower-api",
          statusCode: 200,
          timestamp: "2026-07-06T07:00:00Z",
        }),
      ]),
      async ({ url }) => {
        const result = await runCli(
          ["services", "list", "--since", "2h", "--limit", "3", "--raw"],
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
              queries?: Array<{
                spec?: { filter?: { expression?: string }; limit?: number };
              }>;
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
          services?: unknown;
        };

        expect(parsed).toMatchObject({
          ok: true,
          command: "services list",
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
        ).toBe("service.name != ''");
        expect(parsed.request.compositeQuery?.queries?.[0]?.spec?.limit).toBe(
          60,
        );
        expect(parsed.responseShape.firstRowKeys).toEqual([
          "data",
          "timestamp",
          "trace_id",
        ]);
        expect(parsed.services).toBeUndefined();

        await rm(result.cwd, { recursive: true, force: true });
      },
    );
  });

  it("rejects combining JSON and raw diagnostics", async () => {
    const result = await runCli(["services", "list", "--json", "--raw"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("error Cannot combine --json and --raw\n");

    await rm(result.cwd, { recursive: true, force: true });
  });

  it("stores and prints the selected service by name", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "signoz-agent-test-"));

    try {
      const selectResult = await runCliInCwd(
        ["services", "select", "control-tower-api"],
        cwd,
      );
      const currentResult = await runCliInCwd(["services", "current"], cwd);

      expect(selectResult.exitCode).toBe(0);
      expect(selectResult.stdout).toBe("control-tower-api\n");
      expect(selectResult.stderr).toBe("");
      expect(currentResult.exitCode).toBe(0);
      expect(currentResult.stdout).toBe("control-tower-api\n");
      expect(currentResult.stderr).toBe("");
      await expect(readSession(cwd)).resolves.toMatchObject({
        version: 1,
        traces: [],
        currentService: "control-tower-api",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves trace refs when selecting a service", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "signoz-agent-test-"));

    try {
      await mkdir(join(cwd, ".signoz-agent"), { recursive: true });
      await writeFile(
        join(cwd, ".signoz-agent", "session.json"),
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-07-06T07:00:00.000Z",
            traces: [
              {
                ref: "@t1",
                traceId: "abcdef1234567890abcdef1234567890",
                serviceName: "barry",
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = await runCliInCwd(
        ["services", "select", "control-tower-api"],
        cwd,
      );

      expect(result.exitCode).toBe(0);
      await expect(readSession(cwd)).resolves.toMatchObject({
        traces: [
          {
            ref: "@t1",
            traceId: "abcdef1234567890abcdef1234567890",
            serviceName: "barry",
          },
        ],
        currentService: "control-tower-api",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails clearly when no service is selected", async () => {
    const result = await runCli(["services", "current"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error no selected service; run signoz-agent services select <service-name>\n",
    );

    await rm(result.cwd, { recursive: true, force: true });
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
  serviceName: string;
  statusCode: number;
  timestamp?: string;
}): unknown {
  const row: {
    trace_id: string;
    timestamp?: string;
    data: {
      attributes: {
        "service.name": string;
        "http.response.status_code": number;
      };
    };
  } = {
    trace_id: options.traceId,
    data: {
      attributes: {
        "service.name": options.serviceName,
        "http.response.status_code": options.statusCode,
      },
    },
  };

  if (options.timestamp !== undefined) {
    row.timestamp = options.timestamp;
  }

  return row;
}

async function readSession(cwd: string): Promise<unknown> {
  const text = await readFile(
    join(cwd, ".signoz-agent", "session.json"),
    "utf8",
  );

  return JSON.parse(text) as unknown;
}
