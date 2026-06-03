import { describe, it, expect, vi } from "vitest";
import { RichClient } from "./rich-client.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

function note(update: object) {
  return { sessionId: "s1", update: update as SessionUpdate };
}
const member = { id: "m-A", name: "architect", role: "architect" };

describe("RichClient", () => {
  it("folds session/updates into lanes and renders them; fires onChange", async () => {
    const onChange = vi.fn();
    const c = new RichClient({ onChange });
    await c.sessionUpdate(
      note({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "working" },
        _meta: { swarm: { v: 1, member } },
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(c.renderer.view().lanes).toHaveLength(1);
    expect(c.render().join("\n")).toContain("[architect]");
  });

  it("honors the configured permission policy", async () => {
    const reject = new RichClient({
      onPermission: () => ({ outcome: { outcome: "selected", optionId: "reject" } }),
    });
    const res = await reject.requestPermission({
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "x" },
      options: [],
    } as never);
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "reject" });

    const allow = new RichClient(); // default allow-once
    const res2 = await allow.requestPermission({
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "x" },
      options: [],
    } as never);
    expect(res2.outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });
});
