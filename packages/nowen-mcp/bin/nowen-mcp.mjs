#!/usr/bin/env node
import { runLauncher } from "./runtime-diagnostics.mjs";

const exitCode = await runLauncher();
if (exitCode !== 0) process.exit(exitCode);
