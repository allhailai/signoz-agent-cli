#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { Command } from "commander";

import { registerDoctorCommand } from "./commands/doctor.js";
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
  registerTraceCommand(program);
  registerTracesSearchCommand(program);

  return program;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const program = createProgram();

  if (process.argv.length <= 2) {
    program.help();
  }

  program.parse(process.argv);
}
