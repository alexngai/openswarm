#!/usr/bin/env bun
/**
 * acp-rich-client — the reference swarm-aware ACP client (B2.2, docs/archive/35 §3).
 *
 * Spawns `acp` (a coordinator team), connects as an ACP ClientSideConnection,
 * and renders per-member lanes from `_meta.swarm` (RichClient + formatter). It
 * speaks plain ACP-with-`_meta.swarm` — the same agent drives stock Zed
 * collapsed and this richly (Q5).
 *
 * Operator input:
 *   <text>              send a prompt to the team
 *   /steer <message>    inject a steering message to the lead (swarm/steer)
 *   /steer @<role> <m>  steer a specific role/member
 *   /quit               exit
 *
 * Prereq: `npm run build` (workers spawn from dist/cli.js).
 * Run:    bun scripts/acp-rich-client.ts
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as readline from "node:readline";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { RichClient } from "../src/acp/rich-client.js";

function repaint(client: RichClient): void {
  // Clear screen + home, then paint the current rich view.
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(client.render().join("\n"));
  process.stdout.write("\n\n> ");
}

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    ["src/cli.ts", "acp", "--no-plugins", "--no-skills", "--no-mcp", "--no-hooks"],
    { cwd: process.cwd(), env: { ...process.env }, stdio: ["pipe", "pipe", "inherit"] },
  );
  child.on("error", (e) => {
    process.stderr.write(`spawn failed: ${e.message}\n`);
    process.exit(1);
  });

  const client = new RichClient({ onChange: () => repaint(client) });
  const output = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
  const input = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
  const conn = new ClientSideConnection(() => client, ndJsonStream(output, input));

  await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
  process.stdout.write("swarm-aware client ready. type a prompt, /steer <msg>, or /quit.\n> ");

  const rl = readline.createInterface({ input: process.stdin });
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "/quit") break;
    if (line.length === 0) {
      process.stdout.write("> ");
      continue;
    }
    if (line.startsWith("/steer ")) {
      let rest = line.slice("/steer ".length).trim();
      let target: string | undefined;
      if (rest.startsWith("@")) {
        const sp = rest.indexOf(" ");
        target = rest.slice(1, sp === -1 ? undefined : sp);
        rest = sp === -1 ? "" : rest.slice(sp + 1).trim();
      }
      const res = await conn.extMethod("swarm/steer", {
        message: rest,
        ...(target !== undefined && { target }),
      });
      process.stdout.write(`[steer -> ${JSON.stringify(res)}]\n> `);
      continue;
    }
    // A prompt turn. Render updates as they stream; print the stop reason.
    const res = await conn.prompt({ sessionId, prompt: [{ type: "text", text: line }] });
    process.stdout.write(`\n[turn: ${res.stopReason}]\n> `);
  }

  rl.close();
  child.kill("SIGTERM");
}

void main();
