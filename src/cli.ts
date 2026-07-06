#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { registerDoctorCommand } from "./commands/doctor.js";
import { registerServicesCommand } from "./commands/services.js";
import { registerTraceCommand } from "./commands/trace.js";
import { registerTracesSearchCommand } from "./commands/tracesSearch.js";

const version = "0.1.0";

export function createProgram(): Command {
  const program = new Command()
    .name("signoz-agent")
    .description("Agent-first CLI for investigating SigNoz traces and logs.")
    .version(version)
    .showHelpAfterError();

  registerDoctorCommand(program);
  registerServicesCommand(program);
  registerTraceCommand(program);
  registerTracesSearchCommand(program);

  return program;
}

if (isMainModule()) {
  const program = createProgram();

  if (process.argv.length <= 2) {
    program.help();
  }

  program.parse(process.argv);
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }

  return (
    realpathSync(process.argv[1]) ===
    realpathSync(fileURLToPath(import.meta.url))
  );
}
