import { execFile } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  it("prints help when invoked through an npm-style symlink", async () => {
    const cliPath = join(process.cwd(), "dist", "cli.js");
    const tempDir = await mkdtemp(join(tmpdir(), "signoz-agent-bin-"));
    const binPath = join(tempDir, "signoz-agent");

    await symlink(cliPath, binPath);

    const { stdout } = await execFileAsync(binPath, ["--help"]);

    expect(stdout).toContain("Usage: signoz-agent");
  });
});
