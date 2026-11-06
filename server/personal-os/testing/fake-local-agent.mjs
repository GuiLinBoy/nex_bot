// Synthetic CLI only: no network, real credentials, or files outside fixture HOME/cwd.
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const agent = process.argv[2];
if (process.argv.includes("--version")) { console.log(`${agent}-fixture 0.0.1`); process.exit(0); }
const home = process.env.HOME ?? process.env.USERPROFILE;
if (!home || !process.env.NEX_LOCAL_AGENT_FIXTURE) throw new Error("Synthetic CLI requires an owned fixture");
appendFileSync(path.join(home, "launches.jsonl"), JSON.stringify({ agent, cwd: process.cwd(), argv: process.argv.slice(3), pid: process.pid, leaked: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NEX_CORE_TOKEN", "CLAUDECODE"].some((key) => process.env[key]) }) + "\n");
const send = (packet) => process.stdout.write(JSON.stringify(packet) + "\n");
const threadId = "synthetic-native-session", turnId = "synthetic-turn";
let held = false;
const complete = (error = false) => agent === "codex"
  ? send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: error ? "failed" : "completed", ...(error ? { error: { message: "synthetic failure" } } : {}) } } })
  : send({ type: "result", session_id: threadId, subtype: error ? "error_during_execution" : "success", is_error: error, result: error ? "synthetic failure" : "synthetic complete" });
function run(prompt) {
  if (agent === "claude") send({ type: "system", subtype: "init", session_id: threadId });
  const output = (text) => agent === "codex" ? send({ method: "item/agentMessage/delta", params: { threadId, delta: text } }) : send({ type: "stream_event", event: { delta: { type: "text_delta", text } } });
  output(`synthetic 你好: ${prompt}`);
  if (agent === "claude" && prompt.includes("subagent")) {
    send({ type: "system", subtype: "init", session_id: "other-native-session", parent_tool_use_id: "synthetic-child" });
    send({ type: "stream_event", parent_tool_use_id: "synthetic-child", event: { delta: { type: "text_delta", text: "CHILD-ONLY-OUTPUT" } } });
    send({ type: "result", subtype: "success", session_id: "other-native-session", parent_tool_use_id: "synthetic-child", result: "CHILD-ONLY-RESULT" });
  }
  if (prompt.includes("child")) {
    const helper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
    writeFileSync(path.join(home, "helper.pid"), String(helper.pid));
  }
  if (prompt.includes("approval")) {
    if (agent === "codex") send({ id: "native-approval", method: "item/commandExecution/requestApproval", params: { threadId, turnId, command: "synthetic risky operation", cwd: process.cwd() } });
    else send({ type: "control_request", request_id: "native-approval", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "synthetic risky operation" }, tool_use_id: "synthetic-tool" } });
  } else if (prompt.includes("question") && agent === "codex") send({ id: "native-question", method: "item/tool/requestUserInput", params: { threadId, turnId, questions: [{ id: "q1", question: "synthetic question?" }] } });
  else if (prompt.includes("broken")) process.exit(0);
  else if (prompt.includes("burst")) { for (let i = 0; i < 450; i++) output("synthetic-event-" + i); complete(); }
  else if (!prompt.includes("hold") && !prompt.includes("child")) setTimeout(() => complete(prompt.includes("fail")), 50);
  else held = true;
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const packet = JSON.parse(line);
  if (agent === "codex") {
    if (packet.method === "initialize") send({ id: packet.id, result: {} });
    if (["thread/start", "thread/resume"].includes(packet.method)) {
      if (packet.params.sandbox !== "workspace-write" || packet.params.approvalPolicy !== "on-request") throw new Error("unexpected permission policy");
      send({ id: packet.id, result: { thread: { id: threadId } } });
    }
    if (packet.method === "turn/start" || packet.method === "turn/steer") {
      send({ id: packet.id, result: packet.method === "turn/start" ? { turn: { id: turnId } } : { turnId } });
      run(packet.params.input[0].text);
    }
    if (packet.id === "native-approval" && packet.result) {
      if (packet.result.decision === "accept") writeFileSync(path.join(process.cwd(), "approved.txt"), "synthetic");
      complete(packet.result.decision !== "accept");
    }
    if (packet.id === "native-question") { writeFileSync(path.join(home, "answer.json"), JSON.stringify(packet.result)); complete(); }
  } else {
    if (packet.type === "control_request") send({ type: "control_response", response: { subtype: "success", request_id: packet.request_id, response: {} } });
    if (packet.type === "user") {
      if (held) { held = false; complete(); }
      send({ type: "user", uuid: packet.uuid, message: packet.message });
      run(packet.message.content[0].text);
    }
    if (packet.type === "control_response") {
      const allow = packet.response.response.behavior === "allow";
      if (allow) writeFileSync(path.join(process.cwd(), "approved.txt"), "synthetic");
      complete(!allow);
    }
  }
});
lines.on("close", () => process.exit(0));
