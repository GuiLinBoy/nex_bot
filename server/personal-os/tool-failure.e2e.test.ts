import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { startFakeModel, type FakeModel } from "../runtime/pi/p0/fake-model.ts";

const { createPersonalApp } = await import(process.env.NEX_TEST_BUNDLE
  ? pathToFileURL(path.resolve(process.env.NEX_TEST_BUNDLE)).href : "./index.ts") as typeof import("./index.ts");

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(provider: "openai" | "anthropic") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nex-tool-failure-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const model = await startFakeModel(); cleanup.push(() => model.close());
  const app = await createPersonalApp({ dir, key: randomBytes(32), token: "synthetic", identity: false, memoryRuntime: false, hostDevice: false,
    modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} } });
  cleanup.push(() => app.close());
  app.store.saveConfig({ provider, endpoint: model.origin + "/v1", model: "fixture", apiKey: "synthetic" });
  const bot = app.store.createBot("重复失败验收");
  async function settled(taskId: string) {
    const deadline = Date.now() + 25_000;
    while (app.store.get("SELECT ended_at FROM tasks WHERE id=?", taskId)?.ended_at == null || app.runtime.workers.size) {
      if (Date.now() > deadline) throw new Error("隔离重复失败验收超时");
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return app.store.get("SELECT * FROM tasks WHERE id=?", taskId)!;
  }
  return { app, model, bot, settled };
}
const callId = (index: number) => `call-11111111-2222-4333-8444-555555555555-${index}`;
function tool(model: FakeModel, provider: "openai" | "anthropic", index: number, args: Record<string, unknown>) {
  model.scripts.push(provider === "openai"
    ? { kind: "openai-tool", calls: [{ id: callId(index), name: "broker", args: JSON.stringify(args) }] }
    : { kind: "anthropic-tool", id: callId(index), name: "broker", args: JSON.stringify(args) });
}
function text(model: FakeModel, provider: "openai" | "anthropic", value: string) {
  model.scripts.push({ kind: provider === "openai" ? "openai-text" : "anthropic-text", text: value });
}

it.each(["openai", "anthropic"] as const)("%s repeated invalid calls stop before another model request and retain the last result", async provider => {
  const { app, model, bot, settled } = await fixture(provider);
  for (let i = 0; i < 6; i++) tool(model, provider, i, { action: "device.exec", deviceId: null, command: null });
  text(model, provider, "不应请求到这一轮");
  const sent = app.agents.send(bot, "检查合成本机配置", "repeat-invalid");
  const task = await settled(sent.taskId);
  expect(task.status).toBe("failed");
  expect(task.result_summary).toContain("连续失败 3 次");
  expect(model.requests).toHaveLength(3);
  expect(app.store.all("SELECT * FROM tool_calls WHERE task_id=?", sent.taskId)).toHaveLength(0);
  expect(app.store.all("SELECT * FROM agent_messages WHERE task_id=? AND kind='error'", sent.taskId)).toHaveLength(1);
  const runtime = app.store.get("SELECT runtime_session_id FROM task_runs WHERE task_id=?", sent.taskId)!;
  const entries = app.runtime.projection.load(String(runtime.runtime_session_id))!;
  expect(entries.filter(e => e.type === "message" && e.message.role === "toolResult")).toHaveLength(3);

  // A user retry is a fresh attempt. Old invalid proposals must not replay.
  model.scripts.length = 0;
  text(model, provider, "新输入可以继续");
  const retry = app.agents.send(bot, "换个问题继续", "new-input");
  expect((await settled(retry.taskId)).status).toBe("succeeded");
  expect(model.requests).toHaveLength(4);
  expect(app.store.all("SELECT * FROM tool_calls")).toHaveLength(0);
}, 60_000);

it.each(["openai", "anthropic"] as const)("%s reports the invalid fields, preserves long call IDs and allows correction", async provider => {
  const { app, model, bot, settled } = await fixture(provider);
  tool(model, provider, 0, { action: "device.exec", deviceId: null, command: null });
  tool(model, provider, 1, { action: "device.inventory" });
  text(model, provider, "已改正工具参数");
  const sent = app.agents.send(bot, "验证参数修正", "correct-invalid");
  expect((await settled(sent.taskId)).status).toBe("succeeded");
  expect(model.requests).toHaveLength(3);
  const body = JSON.parse(model.requests[1].body);
  expect(model.requests[1].body).toContain("deviceId");
  expect(model.requests[1].body).toContain("command");
  expect(model.requests[1].body).toContain("null");
  if (provider === "openai") {
    const call = body.messages.flatMap((m: { tool_calls?: unknown[] }) => m.tool_calls ?? [])[0];
    expect(call.id).toBe(callId(0));
    expect(JSON.parse(call.function.arguments)).toEqual({ action: "device.exec", deviceId: null, command: null });
    expect(body.messages.find((m: { role: string }) => m.role === "tool").tool_call_id).toBe(callId(0));
  } else {
    const parts = body.messages.flatMap((m: { content?: unknown }) => Array.isArray(m.content) ? m.content : []);
    expect(parts.find((p: { type: string }) => p.type === "tool_use").id).toBe(callId(0));
    expect(parts.find((p: { type: string }) => p.type === "tool_result").tool_use_id).toBe(callId(0));
  }
  expect(model.requests[1].body).toContain("收到 null");
  expect(app.store.all("SELECT tool_name,status FROM tool_calls WHERE task_id=?", sent.taskId)).toEqual([{ tool_name: "device.inventory", status: "succeeded" }]);
}, 60_000);
