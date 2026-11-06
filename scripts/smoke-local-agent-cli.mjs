// Installed CLIs + the actual built client executor, against synthetic loopback
// inference only. Fresh homes/projects; no user's CLI login, config or data.
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { localAgentEnvironment } from "../server/personal-os/local-agent-environment.ts";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { createClientNode } from "../dist-personal/client-executor/client-node/client-node.js";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-installed-agent-")), answer = "synthetic-local-agent-verified";
const requests = [];
const frame = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const url = new URL(request.url, "http://fixture");
  if (request.method !== "POST") { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"object":"list","data":[]}'); return; }
  if (url.pathname.endsWith("/count_tokens")) { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"input_tokens":16}'); return; }
  requests.push({ path: url.pathname, model: JSON.parse(body || "{}").model });
  const id = randomUUID();
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  if (url.pathname.endsWith("/responses")) {
    const item = { id: "msg_" + id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
    const result = { id: "resp_" + id, object: "response", created_at: Math.floor(Date.now() / 1000), model: "fixture", status: "completed", output: [item], usage: { input_tokens: 16, output_tokens: 8, total_tokens: 24, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.end(frame([
      { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: answer },
      { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: answer },
      { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: result },
    ].map((event, sequence_number) => ({ ...event, sequence_number }))));
  } else response.end(frame([
    { type: "message_start", message: { id: "msg_" + id, type: "message", role: "assistant", model: "fixture", content: [], usage: { input_tokens: 16, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ]));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`, results = [];
let client;
try {
  for (const agent of ["codex", "claude"]) {
    const home = path.join(root, agent), cwd = path.join(home, "项目 space ' &");
    mkdirSync(cwd, { recursive: true }); mkdirSync(path.join(home, ".codex")); mkdirSync(path.join(home, ".claude"));
    writeFileSync(path.join(home, ".codex/config.toml"), `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "${origin}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
    client = createClientNode(path.join(home, "device"), randomBytes(32), () => {}, undefined, { autoConnect: false });
    client.node.agents.options.environment = () => ({ ...localAgentEnvironment({ ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude") }), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...(agent === "claude" ? { ANTHROPIC_API_KEY: "synthetic-fixture-key", ANTHROPIC_BASE_URL: origin, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : {}) });
    const context = { bindingId: "synthetic-core:synthetic-device", botId: "synthetic-bot", taskId: "synthetic-task", callId: randomUUID() };
    const first = await client.node.agents.execute(context, "start", { agent, cwd, prompt: "Return the fixture answer without using tools." });
    let after = 0;
    const wait = async () => {
      const deadline = Date.now() + 45_000; let text = "";
      while (Date.now() < deadline) {
        const status = await client.node.agents.execute(context, "status", { sessionId: first.sessionId, after, waitMs: 1000 });
        after = status.nextCursor; text += status.events.map((event) => event.text).join("\n");
        if (status.status === "completed" && !status.hasMore && !client.node.agents.live.has(first.sessionId)) { if (!text.includes(answer)) throw new Error(`${agent}: completion omitted output`); return status.nativeSessionId; }
        if (["failed", "cancelled", "interrupted", "waiting"].includes(status.status)) throw new Error(`${agent}: ${status.status}: ${status.error ?? JSON.stringify(status.requests)}`);
        // Completion also has to reap the owned process tree before a resume.
        if (status.status === "completed") await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`${agent}: fixture timeout; requests=${JSON.stringify(requests)}`);
    };
    const nativeId = await wait();
    await client.node.agents.execute(context, "send", { sessionId: first.sessionId, prompt: "Return the fixture answer again without tools." });
    if (await wait() !== nativeId) throw new Error(`${agent}: resumed a different native conversation`);
    results.push({ agent, completed: true, resumedSameSession: true, builtExecutor: true });
    await client.close(); client = undefined;
  }
  console.log(JSON.stringify({ isolated: true, syntheticInferenceOnly: true, results, requests }, null, 2));
} finally {
  await client?.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await removeTempDir(root);
}
