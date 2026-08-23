/**
 * commit_changes.test.ts — v0.7 stage 7B.
 */

import { describe, it, expect, vi } from "vitest";
import { commitChangesTool } from "./commit_changes.js";
import { makeFakeHost } from "./_fake-host.js";
import type { CommitChangesResult } from "../../swarm/adapters/git-cascade-branch-policy.js";

const CTX_CWD = process.cwd();

describe("commit_changes tool", () => {
  it("returns 'null' when host.commitChanges returns null (not in a stream)", async () => {
    const { host } = makeFakeHost();
    // Default fake returns null.
    const result = await commitChangesTool.execute(
      { message: "wip" },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.output).toBe("null");
  });

  it("returns the JSON-stringified CommitChangesResult on success", async () => {
    const { host } = makeFakeHost();
    const fakeResult: CommitChangesResult = {
      streamId: "s-7",
      commitSha: "abc123",
      changeId: "I-deadbeef",
    };
    (host as unknown as { commitChanges: typeof host.commitChanges }).commitChanges =
      vi.fn(async () => fakeResult);

    const result = await commitChangesTool.execute(
      { message: "feat: ship 7B", metadata: { taskId: "t-99" } },
      { cwd: CTX_CWD, host },
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.output) as CommitChangesResult;
      expect(parsed).toEqual(fakeResult);
    }
    expect(host.commitChanges).toHaveBeenCalledWith("feat: ship 7B", {
      taskId: "t-99",
    });
  });

  it("rejects empty message", async () => {
    const { host } = makeFakeHost();
    const result = await commitChangesTool.execute(
      { message: "" },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("error");
  });
});
