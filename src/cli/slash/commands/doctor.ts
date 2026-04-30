/**
 * /doctor — in-REPL health probe.
 *
 * Reuses the checks from `src/cli/doctor.ts` where practical. That module
 * prints directly to stdout, which is hostile to the ink-rendered
 * transcript; so we capture its JSON output via a stdout intercept and
 * turn it into a single transcript message.
 *
 * Failure of any check is reported inline; the exit code is ignored —
 * /doctor is informational in the REPL, not a program exit.
 */

import { runDoctor } from "../../doctor.js";
import type { SlashCommand } from "../index.js";

interface DoctorCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "warn";
  readonly message: string;
}

interface DoctorResult {
  readonly checks: readonly DoctorCheck[];
  readonly overall: "pass" | "fail";
}

async function captureDoctorJson(): Promise<DoctorResult | undefined> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await runDoctor("json");
  } finally {
    process.stdout.write = originalWrite;
  }
  const joined = chunks.join("").trim();
  if (joined.length === 0) return undefined;
  try {
    return JSON.parse(joined) as DoctorResult;
  } catch {
    return undefined;
  }
}

function icon(status: DoctorCheck["status"]): string {
  return status === "pass" ? "ok" : status === "warn" ? "warn" : "fail";
}

export const doctorCommand: SlashCommand = {
  name: "doctor",
  description: "Run environment health checks (auth, SDK, workspace, config)",
  async execute() {
    const result = await captureDoctorJson();
    if (result === undefined) {
      return {
        kind: "error",
        message: "doctor: failed to collect results",
      };
    }
    const lines = result.checks.map(
      (c) => `  [${icon(c.status)}] ${c.name}: ${c.message}`,
    );
    return {
      kind: "message",
      text: `doctor (${result.overall}):\n${lines.join("\n")}`,
    };
  },
};
