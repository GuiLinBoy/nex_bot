// Optional installed-CLI contract check. Uses a fresh home, sends initialize
// only, never submits a prompt or reads the user's CLI account/configuration.
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execCli, killCliTree, spawnCli } from "../server/procs.ts";
import { localAgentEnvironment } from "../server/personal-os/local-agent-environment.ts";
import { removeTempDir } from "../server/testing/cleanup.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "nex-cli-contract-"));
const results: { agent: string; version?: string; initialized: boolean; stopped: boolean; error?: string }[] = [];
try {
  for (const agent of ["codex", "claude"] as const) {
    const home = path.join(root, agent); mkdirSync(home, { mode: 0o700 });
    mkdirSync(path.join(home, ".codex"), { mode: 0o700 });
    mkdirSync(path.join(home, ".claude"), { mode: 0o700 });
    const env = localAgentEnvironment({ ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude") });
    const version = await new Promise<string | undefined>((resolve) => execCli(agent, ["--version"], { env, cwd: home, timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim().slice(0, 200))));
    if (!version) { results.push({ agent, initialized: false, stopped: true, error: "CLI not installed or version probe failed" }); continue; }
    const args = agent === "codex" ? ["app-server"] : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages", "--permission-mode", "default", "--permission-prompt-tool=stdio"];
    const child = spawnCli(agent, args, { env, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(-1000); });
    let failure: string | undefined;
    const initialized = await new Promise<boolean>((resolve) => {
      let buffer = "", settled = false;
      const done = (success: boolean, error?: string) => { if (settled) return; settled = true; clearTimeout(timer); failure = error; resolve(success); };
      const timer = setTimeout(() => done(false, "initialize timed out"), 15_000);
      child.stdout.setEncoding("utf8"); child.stdout.on("data", (data: string) => {
        buffer = (buffer + data).slice(-1_000_000);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const packet = JSON.parse(line);
            if (agent === "codex" && packet.id === "nex-contract") done(!packet.error, packet.error?.message);
            if (agent === "claude" && packet.type === "control_response" && packet.response?.request_id === "nex-contract") done(packet.response.subtype === "success", packet.response.error);
          } catch { /* Non-protocol startup output cannot count as success. */ }
        }
      });
      child.once("error", (error) => done(false, error.message)); child.once("close", (code) => done(false, `CLI exited before initialize (${code}): ${stderr}`));
      child.stdin.write(JSON.stringify(agent === "codex" ? { id: "nex-contract", method: "initialize", params: { clientInfo: { name: "nexbot_local_agent", title: "NexBot", version: "1.0.0" }, capabilities: {} } } : { type: "control_request", request_id: "nex-contract", request: { subtype: "initialize", hooks: {}, sdkMcpServers: [] } }) + "\n");
    });
    const stopped = await killCliTree(child);
    results.push({ agent, version, initialized, stopped, ...(failure ? { error: failure } : {}) });
  }
  console.log(JSON.stringify({ isolated: true, inferenceSubmitted: false, results }, null, 2));
  if (results.some((result) => !result.initialized || !result.stopped)) process.exitCode = 1;
} finally { await removeTempDir(root); }
