/**
 * pilot-mock.mjs [port]: an OpenAI-compatible chat-completions mock for the pilot's
 * zero-token plumbing check. It answers by request content, so concurrent members of
 * different threads each get the right script regardless of arrival order:
 *
 *   coordinator plan  ("Decompose this task…" + "## Your thread: <id>")
 *       -> "1. git apply /opt/pilot/ref/<id>.patch"
 *   worker            (prompt carries that command, no tool result yet)
 *       -> bash tool call running it
 *   anything else     (tool result, synthesis) -> "done"
 *
 * Every response reports usage, so a zero usage fold in the SUT is a real bug.
 */
import { createServer } from "node:http";

const text = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("\n"));

function decide(messages) {
  const last = messages.at(-1) ?? {};
  const all = messages.map(text).join("\n");
  if (last.role === "tool" || all.includes("Synthesize the final deliverable")) return { content: "done" };
  const thread = /## Your thread: (\S+)/.exec(all)?.[1];
  if (all.includes("Decompose this task") && thread) return { content: `1. git apply /opt/pilot/ref/${thread}.patch` };
  const cmd = /git apply \/opt\/pilot\/ref\/\S+\.patch/.exec(text(last))?.[0];
  if (cmd) return { tool: { name: "bash", arguments: JSON.stringify({ command: `${cmd} && git status --short | head -5` }) } };
  return { content: "done" };
}

const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
let calls = 0;

createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const r = JSON.parse(body || "{}");
    const d = decide(r.messages ?? []);
    calls++;
    console.log(JSON.stringify({ calls, kind: d.tool ? "tool" : d.content.slice(0, 40) }));
    const delta = d.tool
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: d.tool }] }
      : { role: "assistant", content: d.content };
    const finish = d.tool ? "tool_calls" : "stop";
    const base = { id: `mock-${calls}`, created: 0, model: r.model ?? "mock" };
    if (!r.stream) {
      const message = d.tool ? { role: "assistant", content: null, tool_calls: delta.tool_calls } : { role: "assistant", content: d.content };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...o })}\n\n`);
    send({ choices: [{ index: 0, delta, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage });
    res.end("data: [DONE]\n\n");
  });
}).listen(Number(process.argv[2] ?? 8787), "0.0.0.0", () => console.log("pilot-mock listening"));
