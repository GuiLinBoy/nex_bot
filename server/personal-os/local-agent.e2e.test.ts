import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createPersonalApp } from "./index.ts";
import { createClientNode } from "./client-node.ts";
import { localAgentEnvironment } from "./local-agent.ts";
import { startFakeModel } from "../runtime/pi/p0/fake-model.ts";
import type { AgentRequest } from "./local-agent-contract.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each((["codex", "claude"] as const).flatMap((agent) => ["windows", "macos"].map((platform) => ({ agent, platform }))))("routes $agent through Core approvals and DCP to the selected $platform client, and cancels acknowledged work", async ({ agent, platform }) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nex-agent-dcp-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const fake = await startFakeModel(); cleanup.push(() => fake.close());
  const startApp: typeof createPersonalApp = process.env.NEX_TEST_BUNDLE ? (await import(pathToFileURL(path.resolve(process.env.NEX_TEST_BUNDLE)).href)).createPersonalApp : createPersonalApp;
  const app = await startApp({ dir: path.join(root, "core"), key: randomBytes(32), token: "synthetic", identity: false, memoryRuntime: false, hostDevice: false,
    modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} } }); cleanup.push(() => app.close());
  app.store.saveConfig({ provider: "openai", endpoint: fake.origin + "/v1", model: "fixture", apiKey: "synthetic" });
  const botId = app.store.createBot("本地 CLI 验收");
  const script = fileURLToPath(new URL("./testing/fake-local-agent.mjs", import.meta.url));
  const command = `"${process.execPath}" "${script}"`;
  const startNode: typeof createClientNode = process.env.NEX_TEST_CLIENT_BUNDLE ? (await import(pathToFileURL(path.resolve(process.env.NEX_TEST_CLIENT_BUNDLE)).href)).createClientNode : createClientNode;
  const clients = ["windows", "macos"].map((platform) => {
    const dir = path.join(root, platform), home = path.join(dir, "home"), cwd = path.join(dir, "项目 space ' &"); mkdirSync(home, { recursive: true }); mkdirSync(cwd);
    const client = startNode(dir, randomBytes(32), () => {}, app.origin); cleanup.push(() => client.close());
    const identity = client.node.identity.bind(client.node); client.node.identity = () => ({ ...identity(), platform });
    client.node.agents.options.commands = { codex: command + " codex", claude: command + " claude" };
    client.node.agents.options.environment = () => ({ ...localAgentEnvironment({ ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude") }), NEX_LOCAL_AGENT_FIXTURE: "1" });
    const pair = app.gateway.pair("synthetic " + platform); client.node.configure({ origin: app.origin, token: pair.token, root: cwd, exec: true, computer: false });
    return { ...pair, client, home, cwd };
  });
  await vi.waitFor(() => expect(app.gateway.inventory().filter((device) => device.online && device.granted.agent)).toHaveLength(2));
  const target = clients[platform === "windows" ? 0 : 1], other = clients[platform === "windows" ? 1 : 0];
  const invoke = async (operation: string, parameters: Record<string, unknown>, beforeApproval?: () => void) => {
    await vi.waitFor(() => expect(app.runtime.workers.size).toBe(0));
    const providerId = randomUUID();
    fake.scripts.push({ kind: "openai-tool", calls: [{ id: providerId, name: "broker", args: JSON.stringify({ action: "device.agent", deviceId: target.deviceId, operation, parameters }) }] }, { kind: "openai-text", text: "合成调用已确认" });
    const taskId = app.agents.send(botId, "合成本地 CLI 操作 " + operation, randomUUID()).taskId;
    if (["start", "send", "respond"].includes(operation)) {
      await vi.waitFor(() => expect(app.store.get("SELECT id FROM approvals WHERE status='pending'")).toBeDefined(), { timeout: 10_000 });
      beforeApproval?.();
      const approval = app.store.get("SELECT * FROM approvals WHERE status='pending'")!;
      const response = await fetch(app.origin + "/api/approvals", { method: "POST", headers: { Authorization: "Bearer synthetic", "Content-Type": "application/json" }, body: JSON.stringify({ id: approval.id, hash: approval.argument_hash, allow: true }) });
      expect(response.status).toBe(200);
    }
    await vi.waitFor(() => expect(app.store.get("SELECT status FROM tasks WHERE id=?", taskId)?.status).toBe("succeeded"), { timeout: 10_000 });
    const call = app.store.get("SELECT * FROM tool_calls WHERE provider_tool_call_id=?", providerId)!;
    expect(call.status).toBe("succeeded");
    return { taskId, call, result: JSON.parse(String(call.result_json)) as { sessionId: string; status: string; requests: AgentRequest[] } };
  };
  const start = await invoke("start", { agent, cwd: target.cwd, prompt: "synthetic approval" }, () => expect(existsSync(path.join(target.home, "launches.jsonl"))).toBe(false));
  await vi.waitFor(() => expect(target.client.node.agents.live.get(start.result.sessionId)?.requests.size).toBe(1));
  const status = await invoke("status", { sessionId: start.result.sessionId }); expect(status.result.status).toBe("waiting");
  await invoke("respond", { sessionId: start.result.sessionId, request: status.result.requests[0], allow: true }, () => expect(existsSync(path.join(target.cwd, "approved.txt"))).toBe(false));
  await vi.waitFor(() => expect(readFileSync(path.join(target.cwd, "approved.txt"), "utf8")).toBe("synthetic"));
  expect(existsSync(path.join(other.home, "launches.jsonl"))).toBe(false);
  const held = await invoke("start", { agent, cwd: target.cwd, prompt: "synthetic hold" });
  await vi.waitFor(() => expect(target.client.node.agents.live.get(held.result.sessionId)?.ready).toBe(true));
  // The start DCP call is already acknowledged, so the old pending-call-only
  // cancellation path would leave this CLI running.
  app.gateway.cancelTask(held.taskId);
  await vi.waitFor(async () => expect(await target.client.node.agents.execute({ bindingId: app.store.get("SELECT core_id FROM workspaces")!.core_id + ":" + target.deviceId, botId, taskId: held.taskId, callId: "inspect" }, "status", { sessionId: held.result.sessionId })).toMatchObject({ status: "cancelled" }));
  // A client that predates the new executor must not be mistaken for support.
  const grant = app.store.get("SELECT scope_json FROM device_local_grants WHERE device_id=?", other.deviceId)!;
  app.store.run("UPDATE device_local_grants SET scope_json=? WHERE device_id=?", JSON.stringify({ ...JSON.parse(String(grant.scope_json)), agent: false }), other.deviceId);
  expect(app.gateway.inventory().find((device) => device.id === other.deviceId)!.granted.agent).toBe(false);
}, 40_000);
