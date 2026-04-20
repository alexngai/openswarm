#!/usr/bin/env node
import { VERSION, greet } from "./index.js";

const [, , cmd, ...args] = process.argv;

switch (cmd) {
  case undefined:
  case "help":
  case "-h":
  case "--help":
    console.log(
      [
        `swarm-coder v${VERSION}`,
        "",
        "Usage:",
        "  swarm-coder <command> [args]",
        "",
        "Commands:",
        "  hello [name]   Print a greeting",
        "  version        Print the version",
        "  help           Show this message",
      ].join("\n"),
    );
    break;
  case "version":
  case "-v":
  case "--version":
    console.log(VERSION);
    break;
  case "hello":
    console.log(greet(args[0]));
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error("Run `swarm-coder help` for usage.");
    process.exit(1);
}
