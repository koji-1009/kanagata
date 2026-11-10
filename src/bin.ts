#!/usr/bin/env node
import { main } from "./cli.ts";
import { nodeIo } from "./node-io.ts";

process.exitCode = main(process.argv.slice(2), nodeIo);
