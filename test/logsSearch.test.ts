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

describe("logs search command", () => {
  it("fails with log next steps when no service is selected", async () => {
    const result = await runCli(["logs", "search"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "error no service selected",
        "Next:",
        "- signoz-agent services list --since 2h",
        "- signoz-agent services select <service-name>",
        '- signoz-agent logs search --filter "<expr>"',
        '- signoz-agent logs search --contains "<text>"',
        "",
      ].join("\n"),
    );

    await rm(result.cwd, { recursive: true, force: true });
  });

  it("searches logs by direct filter and writes log refs without breaking trace refs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "signoz-agent-logs-test-"));

    try {
      await writeSession(cwd, {
        version: 1,
        updatedAt: "2026-07-06T07:00:00.000Z",
        currentService: "control-tower-api",
        traces: [
          {
            ref: "@t1",
            traceId: "trace-from-existing-cache",
            serviceName: "barry",
          },
        ],
      });

      await withFakeSigNoz(
        rawRows([
          logRow({
            timestamp: "2026-07-06T07:10:00Z",
            level: "INFO",
            message: "agent run started",
            traceId: "abcdef1234567890abcdef1234567890",
          }),
          logRow({
            timestamp: "2026-07-06T07:11:00Z",
            level: "WARN",
            message: "log without trace",
          }),
        ]),
        async ({ requests, url }) => {
          const result = await runCliInCwd(
            [
              "logs",
              "search",
              "--filter",
              "barry.agent_run_id = '4'",
              "--since",
              "2h",
            ],
            cwd,
            cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
          );

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe("");
          expect(result.stdout).toContain(
            "2 matching logs for filter=barry.agent_run_id = '4' since=2h\n",
          );
          expect(result.stdout).toContain(
            "@l1 2026-07-06T07:10:00Z INFO trace=abcdef123456... agent run started\n",
          );
          expect(result.stdout).toContain(
            "@l2 2026-07-06T07:11:00Z WARN trace=? log without trace\n",
          );

          const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
            compositeQuery?: {
              queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
            };
          };

          expect(
            requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
          ).toBe("barry.agent_run_id = '4'");
          await expect(readSession(cwd)).resolves.toMatchObject({
            currentService: "control-tower-api",
            traces: [
              {
                ref: "@t1",
                traceId: "trace-from-existing-cache",
              },
            ],
            logs: [
              {
                ref: "@l1",
                traceId: "abcdef1234567890abcdef1234567890",
                level: "INFO",
                message: "agent run started",
                attributes: {
                  component: "worker",
                },
              },
              {
                ref: "@l2",
                level: "WARN",
                message: "log without trace",
              },
            ],
          });
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("searches logs by contains text", async () => {
    await withFakeSigNoz(rawRows([]), async ({ requests, url }) => {
      const result = await runCli(
        ["logs", "search", "--contains", "hello world", "--since", "2h"],
        cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("0 matching logs containing=hello world");

      const requestBody = JSON.parse(requests[0]?.body ?? "{}") as {
        compositeQuery?: {
          queries?: Array<{ spec?: { filter?: { expression?: string } } }>;
        };
      };

      expect(
        requestBody.compositeQuery?.queries?.[0]?.spec?.filter?.expression,
      ).toBe("body contains 'hello world'");
      await rm(result.cwd, { recursive: true, force: true });
    });
  });

  it("searches explicit trace-correlated logs", async () => {
    await withFakeSigNoz(rawRows([]), async ({ requests, url }) => {
      const result = await runCli(
        ["logs", "search", "--trace-id", "trace-abc", "--since", "2h"],
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
      ).toBe("trace_id = 'trace-abc'");
      await rm(result.cwd, { recursive: true, force: true });
    });
  });

  it("uses the selected service when no explicit selector is provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "signoz-agent-logs-test-"));

    try {
      await writeSession(cwd, {
        version: 1,
        updatedAt: "2026-07-06T07:00:00.000Z",
        traces: [],
        currentService: "control-tower-api",
      });

      await withFakeSigNoz(rawRows([]), async ({ requests, url }) => {
        const result = await runCliInCwd(
          ["logs", "search", "--since", "30m"],
          cwd,
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain(
          "0 matching logs for service=control-tower-api since=30m\n",
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
          logs: [],
        });
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prints JSON with parsed logs, raw rows, and refs", async () => {
    await withFakeSigNoz(
      rawRows([
        logRow({
          timestamp: "2026-07-06T07:10:00Z",
          level: "INFO",
          message: "agent run started",
          traceId: "trace-json",
        }),
      ]),
      async ({ url }) => {
        const result = await runCli(
          ["logs", "search", "--contains", "agent run", "--json"],
          cliEnv({ SIGNOZ_API_URL: url, SIGNOZ_API_KEY: "test-secret" }),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");

        const parsed = JSON.parse(result.stdout) as {
          ok: boolean;
          count: number;
          query: { contains: string; since: string; limit: number };
          refs: Array<{ ref: string; traceId: string; message: string }>;
          logs: Array<{
            traceId: string;
            message: string;
            attributes: Record<string, unknown>;
            raw: unknown;
          }>;
        };

        expect(parsed).toMatchObject({
          ok: true,
          count: 1,
          query: {
            contains: "agent run",
            since: "30m",
            limit: 20,
          },
          refs: [
            {
              ref: "@l1",
              traceId: "trace-json",
              message: "agent run started",
            },
          ],
          logs: [
            {
              traceId: "trace-json",
              message: "agent run started",
              attributes: {
                component: "worker",
              },
            },
          ],
        });
        expect(parsed.logs[0]?.raw).toBeDefined();
        await rm(result.cwd, { recursive: true, force: true });
      },
    );
  });

  it("prints raw query_range diagnostics for log searches", async () => {
    await withFakeSigNoz(
      rawRows([
        logRow({
          timestamp: "2026-07-06T07:10:00Z",
          level: "INFO",
          message: "agent run started",
          traceId: "trace-json",
        }),
      ]),
      async ({ url }) => {
        const result = await runCli(
          ["logs", "search", "--contains", "agent run", "--raw"],
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
          command: "logs search",
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
        ).toBe("body contains 'agent run'");
        expect(parsed.responseShape.firstRowKeys).toEqual([
          "attributes",
          "body",
          "severity_text",
          "timestamp",
        ]);
      },
    );
  });

  it("rejects combining explicit selectors", async () => {
    const result = await runCli([
      "logs",
      "search",
      "--filter",
      "barry.agent_run_id = '4'",
      "--contains",
      "hello world",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "error Cannot combine --filter, --contains, or --trace-id\n",
    );

    await rm(result.cwd, { recursive: true, force: true });
  });

  it("rejects combining JSON and raw diagnostics", async () => {
    const result = await runCli([
      "logs",
      "search",
      "--contains",
      "hello world",
      "--json",
      "--raw",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("error Cannot combine --json and --raw\n");

    await rm(result.cwd, { recursive: true, force: true });
  });
});

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = cliEnv(),
): Promise<CliResult> {
  const cwd = await mkdtemp(join(tmpdir(), "signoz-agent-logs-test-"));

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

function logRow(options: {
  timestamp: string;
  level: string;
  message: string;
  traceId?: string;
}): unknown {
  const attributes: Record<string, unknown> = {
    component: "worker",
  };

  if (options.traceId !== undefined) {
    attributes.trace_id = options.traceId;
  }

  return {
    timestamp: options.timestamp,
    severity_text: options.level,
    body: options.message,
    attributes,
  };
}

async function readSession(cwd: string): Promise<unknown> {
  const text = await readFile(
    join(cwd, ".signoz-agent", "session.json"),
    "utf8",
  );

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
