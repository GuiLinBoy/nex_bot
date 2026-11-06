import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { LocalAgentSessions, localAgentEnvironment } from "./local-agent.ts";
import { localAgentParameters, type LocalAgentKind, type AgentRequest } from "./local-agent-contract.ts";
import { dangerousEffect } from "./risk.ts";
import { resolveCliSpawn } from "../env-path.ts";

type Snapshot = { sessionId: string; status: string; nativeSessionId: string | null; requests: AgentRequest[]; events: { seq: number; text: string }[]; nextCursor: number; hasMore: boolean; truncated: boolean; error: string | null };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(maxRunMs?: number) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "nex-local-agent-"))), home = path.join(root, "home"), cwd = path.join(root, "项目 ' & space");
  mkdirSync(home); mkdirSync(cwd);
  const db = new DatabaseSync(path.join(root, "journal.db")); db.exec("PRAGMA foreign_keys=ON");
  const script = fileURLToPath(new URL("./testing/fake-local-agent.mjs", import.meta.url));
  const quote = (s: string) => '"' + s.replaceAll('"', '\\"') + '"';
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const options = { commands: { codex: `${command} codex`, claude: `${command} claude` }, environment: () => ({ ...localAgentEnvironment({ ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), OPENAI_API_KEY: "synthetic-never-forward", NEX_CORE_TOKEN: "synthetic-never-forward", CLAUDECODE: "synthetic-parent" }), NEX_LOCAL_AGENT_FIXTURE: "1" }), maxRunMs };
  const manager = new LocalAgentSessions(db, options);
  cleanup.push(async () => { await manager.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const context = { bindingId: "fixture-core:fixture-device", botId: "fixture-bot", taskId: "fixture-task", callId: randomUUID() };
  const call = (operation: string, parameters?: Record<string, unknown>, changes = {}) => manager.execute({ ...context, ...changes }, operation, parameters);
  const start = async (agent: LocalAgentKind, prompt = "synthetic hold") => await call("start", { agent, cwd, prompt }, { callId: randomUUID() }) as Snapshot;
  const status = async (id: string, extra = {}) => await call("status", { sessionId: id, ...extra }) as Snapshot;
  const until = async (id: string, state: string) => { await vi.waitFor(async () => { expect((await status(id)).status).toBe(state); }, { timeout: 10_000, interval: 20 }); return status(id); };
  return { root, home, cwd, db, manager, context, options, call, start, status, until };
}

it("passes local identity/config locations without provider or Core credentials", () => {
  expect(localAgentEnvironment({ HOME: "/synthetic", USERPROFILE: "C:\\synthetic", CODEX_HOME: "/synthetic/codex", CLAUDE_CONFIG_DIR: "/synthetic/claude", OPENAI_API_KEY: "no", ANTHROPIC_API_KEY: "no", NEX_CORE_TOKEN: "no", CLAUDECODE: "no" }, "synthetic-path")).toMatchObject({ HOME: "/synthetic", CODEX_HOME: "/synthetic/codex", CLAUDE_CONFIG_DIR: "/synthetic/claude", PATH: "synthetic-path" });
  const filtered = localAgentEnvironment({ OPENAI_API_KEY: "no", ANTHROPIC_API_KEY: "no", NEX_CORE_TOKEN: "no", CLAUDECODE: "no" }, "synthetic");
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NEX_CORE_TOKEN", "CLAUDECODE"]) expect(filtered).not.toHaveProperty(name);
  expect(localAgentEnvironment({ https_proxy: "http://127.0.0.1:12345", NO_PROXY: "localhost", NODE_EXTRA_CA_CERTS: "/synthetic/cert.pem" }, "synthetic")).toMatchObject({ https_proxy: "http://127.0.0.1:12345", NO_PROXY: "localhost", NODE_EXTRA_CA_CERTS: "/synthetic/cert.pem" });
});

it.each(["codex", "claude"] as const)("discovers and runs %s in a quoted Unicode directory, streams output, sends input and resumes the exact native session", async (agent) => {
  const f = fixture();
  expect(await f.call("discover")).toMatchObject({ agents: [{ agent: "codex", installed: true, version: "codex-fixture 0.0.1" }, { agent: "claude", installed: true }] });
  const run = await f.start(agent); await f.until(run.sessionId, "running");
  await vi.waitFor(async () => expect((await f.status(run.sessionId)).events.some((event) => event.text.includes("你好"))).toBe(true));
  // A short control call returns while its independently owned CLI stays alive.
  expect(f.manager.active).toBe(true);
  await f.call("send", { sessionId: run.sessionId, prompt: "synthetic finish" });
  await f.until(run.sessionId, "completed");
  await f.call("send", { sessionId: run.sessionId, prompt: "synthetic resumed" });
  expect((await f.until(run.sessionId, "completed")).nativeSessionId).toBe("synthetic-native-session");
  const launches = readFileSync(path.join(f.home, "launches.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(launches).toHaveLength(2); expect(launches.every((row) => !row.leaked && row.cwd === f.cwd)).toBe(true);
  if (agent === "claude") expect(launches[1].argv).toContain("--resume");
});

it.each(["codex", "claude"] as const)("binds %s approval to its exact native request and owner", async (agent) => {
  const f = fixture(), run = await f.start(agent, "synthetic approval");
  const waiting = await f.until(run.sessionId, "waiting"), request = waiting.requests[0];
  expect(request).toBeDefined(); expect(existsSync(path.join(f.cwd, "approved.txt"))).toBe(false);
  await expect(f.call("respond", { sessionId: run.sessionId, request: { ...request, details: {} }, allow: true })).rejects.toThrow("不匹配");
  await expect(f.call("respond", { sessionId: run.sessionId, request, allow: true }, { botId: "other-bot" })).rejects.toThrow("不属于");
  await expect(f.call("stop", { sessionId: run.sessionId }, { bindingId: "other-core:other-device" })).rejects.toThrow("不属于");
  expect(await f.call("list", {}, { botId: "other-bot" })).toEqual({ sessions: [] });
  await f.call("respond", { sessionId: run.sessionId, request, allow: true });
  await f.until(run.sessionId, "completed"); expect(readFileSync(path.join(f.cwd, "approved.txt"), "utf8")).toBe("synthetic");
  await expect(f.call("respond", { sessionId: run.sessionId, request, allow: true })).rejects.toThrow("失效");
});

it.each(["codex", "claude"] as const)("rejects %s native permission without granting it", async (agent) => {
  const f = fixture(), run = await f.start(agent, "synthetic approval");
  const waiting = await f.until(run.sessionId, "waiting");
  await f.call("respond", { sessionId: run.sessionId, request: waiting.requests[0], allow: false });
  await f.until(run.sessionId, "failed"); expect(existsSync(path.join(f.cwd, "approved.txt"))).toBe(false);
});

it("answers native Codex questions and paginates bounded event output", async () => {
  const f = fixture(), run = await f.start("codex", "synthetic question");
  const waiting = await f.until(run.sessionId, "waiting");
  await f.call("respond", { sessionId: run.sessionId, request: waiting.requests[0], allow: true, answers: { q1: ["synthetic choice"] } });
  await f.until(run.sessionId, "completed");
  expect(JSON.parse(readFileSync(path.join(f.home, "answer.json"), "utf8"))).toEqual({ answers: { q1: { answers: ["synthetic choice"] } } });
  await f.call("send", { sessionId: run.sessionId, prompt: "synthetic burst" }); await f.until(run.sessionId, "completed");
  expect((await f.status(run.sessionId)).truncated).toBe(true);
  const texts: string[] = []; let after = 0, page: Snapshot;
  do { page = await f.status(run.sessionId, { after }); texts.push(...page.events.map((event) => event.text)); after = page.nextCursor; } while (page.hasMore);
  expect(texts.length).toBeLessThanOrEqual(400); expect(texts).toContain("synthetic-event-449");
  expect((await f.status(run.sessionId, { after })).truncated).toBe(false);
});

it.each(["codex", "claude"] as const)("stops %s and its owned child process after its start call has completed", async (agent) => {
  const f = fixture(), run = await f.start(agent, "synthetic child"); await f.until(run.sessionId, "running");
  await vi.waitFor(() => expect(existsSync(path.join(f.home, "helper.pid"))).toBe(true));
  const helper = Number(readFileSync(path.join(f.home, "helper.pid"), "utf8"));
  await f.manager.cancelTask(f.context.bindingId, f.context.taskId);
  await f.until(run.sessionId, "cancelled");
  await vi.waitFor(() => expect(() => process.kill(helper, 0)).toThrow(), { timeout: 5000 });
});

it("never starts after immediate cancellation or executor shutdown", async () => {
  const f = fixture();
  const start = f.manager.execute(f.context, "start", { agent: "codex", cwd: f.cwd, prompt: "synthetic hold" });
  await f.manager.cancelTask(f.context.bindingId, f.context.taskId); await start;
  expect((await f.status(f.context.callId)).status).toBe("cancelled");
  expect(existsSync(path.join(f.home, "launches.jsonl"))).toBe(false);
});

it("keeps a nested Claude agent's session, output and completion separate from the active parent", async () => {
  const f = fixture(), run = await f.start("claude", "synthetic subagent hold");
  const status = await f.until(run.sessionId, "running");
  await vi.waitFor(async () => expect((await f.status(run.sessionId)).events.some((event) => event.text.includes("你好"))).toBe(true));
  expect(status.nativeSessionId).toBe("synthetic-native-session");
  expect((await f.status(run.sessionId)).events.some((event) => event.text.includes("CHILD-ONLY"))).toBe(false);
  await f.call("send", { sessionId: run.sessionId, prompt: "synthetic finish parent" });
  expect((await f.until(run.sessionId, "completed")).nativeSessionId).toBe("synthetic-native-session");
});

it("marks interrupted work on restart without replay and resumes only on explicit input", async () => {
  const f = fixture(), run = await f.start("codex"); await f.until(run.sessionId, "running"); await f.manager.close();
  f.db.prepare("UPDATE local_agent_sessions SET status='running' WHERE id=?").run(run.sessionId);
  const replacement = new LocalAgentSessions(f.db, f.options); cleanup.push(() => replacement.close());
  expect(await replacement.execute(f.context, "status", { sessionId: run.sessionId })).toMatchObject({ status: "interrupted" });
  expect(readFileSync(path.join(f.home, "launches.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  await replacement.execute(f.context, "send", { sessionId: run.sessionId, prompt: "synthetic resumed" });
  await vi.waitFor(async () => expect(await replacement.execute(f.context, "status", { sessionId: run.sessionId })).toMatchObject({ status: "completed" }), { timeout: 5000 });
});

it.each(["codex", "claude"] as const)("does not mistake %s process exit or model errors for success", async (agent) => {
  const f = fixture(), broken = await f.start(agent, "synthetic broken");
  expect((await f.until(broken.sessionId, "failed")).error).toContain("完成事件前退出");
  const failed = await f.start(agent, "synthetic fail"); expect((await f.until(failed.sessionId, "failed")).error).toContain("synthetic failure");
});

it("enforces typed operations and Core approval even when a model declares standard risk", () => {
  for (const operation of ["start", "send", "respond"]) expect(dangerousEffect({ action: "device.agent", operation, risk: "standard", parameters: { allow: true } })).toBe(true);
  for (const operation of ["discover", "list", "status", "stop"]) expect(dangerousEffect({ action: "device.agent", operation })).toBe(false);
  expect(dangerousEffect({ action: "device.agent", operation: "respond", parameters: { allow: false } })).toBe(false);
  for (const parameters of [{ agent: "shell", cwd: "/tmp", prompt: "x" }, { agent: "codex", cwd: "/tmp", prompt: "x", args: ["--yolo"] }]) expect(() => localAgentParameters("start", parameters)).toThrow();
  expect(() => localAgentParameters("status", { sessionId: "x", waitMs: 30_000 })).toThrow();
});

it("resolves Windows npm shims without a shell and preserves quoting-sensitive JSON argv", () => {
  const f = fixture(), dir = path.join(f.root, "Windows npm 用户 space"); mkdirSync(dir);
  const shim = path.join(dir, "codex.cmd"), script = path.join(dir, "cli.js"), node = path.join(dir, "node.exe");
  writeFileSync(script, "// synthetic, never executed"); writeFileSync(node, "synthetic, never executed");
  writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\cli.js" %*\r\n');
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const args = ["app-server", '{"text":"中文 \\"quoted\\" & %PATH% ; $()"}'];
    expect(resolveCliSpawn(shim, args)).toEqual({ command: node, args: [script, ...args] });
    const native = path.join(dir, "claude.exe"); writeFileSync(native, "synthetic, never executed");
    expect(resolveCliSpawn(native, args)).toEqual({ command: native, args });
  } finally { Object.defineProperty(process, "platform", platform); }
});

it("keeps both CLIs alive beyond the old terminal deadline and closes them on executor shutdown", async () => {
  const f = fixture(), codex = await f.start("codex"), claude = await f.start("claude");
  await f.until(codex.sessionId, "running"); await f.until(claude.sessionId, "running");
  await new Promise((resolve) => setTimeout(resolve, 21_000));
  expect((await f.status(codex.sessionId)).status).toBe("running");
  expect((await f.status(claude.sessionId)).status).toBe("running");
  await f.manager.close(); expect(f.manager.live.size).toBe(0);
}, 30_000);
