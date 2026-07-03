import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("signoz-agent CLI", () => {
  it("prints help and exits successfully", async () => {
    const cliPath = join(process.cwd(), "dist", "cli.js");

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "--help",
    ]);

    expect(stdout).toContain("Usage: signoz-agent");
    expect(stdout).toContain("Agent-first CLI");
    expect(stdout).toContain("--help");
  });

  it("prints help when no command is provided", async () => {
    const cliPath = join(process.cwd(), "dist", "cli.js");

    const { stdout } = await execFileAsync(process.execPath, [cliPath]);

    expect(stdout).toContain("Usage: signoz-agent");
  });
});
