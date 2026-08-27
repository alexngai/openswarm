/**
 * The terminal trust prompt.
 *
 * Shows what the workspace would activate before asking, because "do you trust
 * this folder?" with no inventory is a question people answer by reflex. The
 * three choices follow the design proposed for OpenCode in sst/opencode#6361:
 * trust this configuration, trust this directory permanently, or refuse.
 *
 * @security Only reached when there is something to consent to, and only when
 * both streams are a TTY. A non-TTY caller gets no prompt at all — see
 * `resolveTrust`, which denies rather than assuming.
 */

import { summarize, type Provenance } from "../trust/provenance.js";
import type { TrustAnswer } from "../trust/gate.js";

export interface ReadlineLike {
  question(prompt: string): Promise<string>;
  close(): void;
}

async function defaultReadline(): Promise<ReadlineLike> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return { question: (p: string) => rl.question(p), close: () => rl.close() };
}

export interface TrustPromptOptions {
  readonly readlineFactory?: () => Promise<ReadlineLike>;
  readonly write?: (s: string) => void;
}

/** True when we can actually ask a person. */
export function canPrompt(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function makeTrustPrompt(opts: TrustPromptOptions = {}) {
  const write = opts.write ?? ((s: string) => process.stderr.write(s));
  const factory = opts.readlineFactory ?? defaultReadline;

  return async function prompt(
    provenance: Provenance,
    situation: "unknown" | "stale",
  ): Promise<TrustAnswer> {
    const heading =
      situation === "stale"
        ? "This workspace's configuration has changed since you trusted it."
        : "This workspace contains configuration that can run programs.";

    write(`\n${heading}\n\n  ${provenance.root}\n\n`);
    for (const line of summarize(provenance)) write(`  ${line}\n`);
    write(
      "\nTrusting it lets the above run without further confirmation.\n" +
        "  1) Trust this configuration — ask again if these files change\n" +
        "  2) Trust this directory — do not ask again\n" +
        "  3) Do not trust — exit\n",
    );

    const rl = await factory();
    try {
      // Anything unrecognized is a refusal. A trust prompt that treats a
      // stray keystroke or an EOF as consent is not a gate.
      const raw = (await rl.question("\n> ")).trim();
      if (raw === "1") return { kind: "trust", scope: "config" };
      if (raw === "2") return { kind: "trust", scope: "directory" };
      return { kind: "deny" };
    } catch {
      return { kind: "deny" };
    } finally {
      rl.close();
    }
  };
}
