import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { spawnCli, killCliTree } from "../procs.ts";
import { localAgentEnvironment } from "./local-agent-environment.ts";
import { resetPathCache } from "../env-path.ts";
export { localAgentEnvironment } from "./local-agent-environment.ts";
import { canonical } from "./store.ts";
import { agentObject, agentText, localAgentParameters, type AgentRequest, type LocalAgentKind } from "./local-agent-contract.ts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
type Context = { bindingId: string; botId: string; taskId: string; callId: string };
interface Session {
  id: string; binding_id: string; bot_id: string; task_id: string; agent: LocalAgentKind;
  cwd: string; native_id: string | null; status: string; error: string | null; created_at: number; updated_at: number;
  dropped_through: number;
}
interface Pending { preview: AgentRequest; wireId: string | number }
interface Live {
  id: string; agent: LocalAgentKind; child: ReturnType<typeof spawnCli>; ready: boolean; finished: boolean;
  turnId?: string; inputs: Set<string>; stderr: string; timer: NodeJS.Timeout;
  rpc: Map<string, { resolve: (value: ObjectValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  requests: Map<string, Pending>;
}

/** Long-lived work is separate from a DCP control call's short delivery lease.
 * The journal acknowledges start/send once; a reconnect never replays a prompt. */
export class LocalAgentSessions {
  readonly live = new Map<string, Live>();
  private readonly finishing = new Map<string, Promise<boolean>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private closed = false;
  private closing = false;
  constructor(readonly db: DatabaseSync, readonly options: {
    commands?: Partial<Record<LocalAgentKind, string>>;
    environment?: () => NodeJS.ProcessEnv;
    changed?: () => void;
    maxRunMs?: number;
  } = {}) {
    db.exec(`CREATE TABLE IF NOT EXISTS local_agent_sessions(
      id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,bot_id TEXT NOT NULL,task_id TEXT NOT NULL,
      agent TEXT NOT NULL,cwd TEXT NOT NULL,native_id TEXT,status TEXT NOT NULL,error TEXT,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,dropped_through INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS local_agent_events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES local_agent_sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS local_agent_events_session ON local_agent_events(session_id,seq);`);
    if (!db.prepare("PRAGMA table_info(local_agent_sessions)").all().some((column) => column.name === "dropped_through")) db.exec("ALTER TABLE local_agent_sessions ADD COLUMN dropped_through INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE local_agent_sessions SET status='interrupted',error='设备执行器已重启；需明确发送指令继续',updated_at=? WHERE status IN ('starting','running','waiting')").run(Date.now());
  }
  get active() { return !!this.db.prepare("SELECT id FROM local_agent_sessions WHERE status IN ('starting','running','waiting') LIMIT 1").get(); }
  private capacity() { return Number(this.db.prepare("SELECT COUNT(*) n FROM local_agent_sessions WHERE status IN ('starting','running','waiting')").get()!.n) < 4; }
  private env() { return this.options.environment?.() ?? localAgentEnvironment(); }
  private command(agent: LocalAgentKind) { return this.options.commands?.[agent] ?? agent; }
  private row(id: string) { return this.db.prepare("SELECT * FROM local_agent_sessions WHERE id=?").get(id) as unknown as Session | undefined; }
  private owned(context: Context, id: unknown) {
    const row = this.row(agentText(id, "sessionId", 100));
    if (!row || row.binding_id !== context.bindingId || row.bot_id !== context.botId) throw new Error("本地 Agent 会话不存在或不属于当前 Bot");
    return row;
  }
  private event(id: string, kind: string, text: string) {
    if (this.closed) return;
    this.db.prepare("INSERT INTO local_agent_events(session_id,kind,text,created_at) VALUES(?,?,?,?)").run(id, kind, text.slice(0, 8000), Date.now());
    const removed = this.db.prepare("DELETE FROM local_agent_events WHERE session_id=? AND seq NOT IN(SELECT seq FROM local_agent_events WHERE session_id=? ORDER BY seq DESC LIMIT 400) RETURNING seq").all(id, id);
    if (removed.length) this.db.prepare("UPDATE local_agent_sessions SET dropped_through=MAX(dropped_through,?) WHERE id=?").run(Math.max(...removed.map((event) => Number(event.seq))), id);
    this.db.prepare("UPDATE local_agent_sessions SET updated_at=? WHERE id=?").run(Date.now(), id);
    for (const wake of this.waiters.get(id) ?? []) wake();
    this.options.changed?.();
  }
  private state(id: string, status: string, error: string | null = null) {
    if (this.closed) return;
    this.db.prepare("UPDATE local_agent_sessions SET status=?,error=?,updated_at=? WHERE id=?").run(status, error?.slice(0, 4000) ?? null, Date.now(), id);
    this.event(id, "status", error ? `${status}: ${error}` : status);
  }
  private snapshot(row: Session, after = 0) {
    const events = this.db.prepare("SELECT seq,kind,text,created_at AS createdAt FROM local_agent_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 40").all(row.id, after);
    const bounds = this.db.prepare("SELECT MIN(seq) first,MAX(seq) last FROM local_agent_events WHERE session_id=?").get(row.id)!;
    const next = events.length ? Number(events.at(-1)!.seq) : after;
    return { sessionId: row.id, agent: row.agent, cwd: row.cwd, status: row.status, nativeSessionId: row.native_id, error: row.error,
      events, nextCursor: next, hasMore: Number(bounds.last ?? 0) > next, truncated: after < row.dropped_through,
      requests: [...(this.live.get(row.id)?.requests.values() ?? [])].map((item) => item.preview) };
  }
  async execute(context: Context, operation: unknown, value?: unknown): Promise<unknown> {
    if (this.closed || this.closing) throw new Error("本地 Agent 执行器已停止");
    const p = localAgentParameters(operation, value);
    if (operation === "discover") { resetPathCache(); return { agents: await Promise.all((["codex", "claude"] as const).map((agent) => this.probe(agent))) }; }
    if (operation === "list") return { sessions: (this.db.prepare("SELECT * FROM local_agent_sessions WHERE binding_id=? AND bot_id=? ORDER BY updated_at DESC LIMIT 50").all(context.bindingId, context.botId) as unknown as Session[])
      .map((row) => ({ sessionId: row.id, agent: row.agent, cwd: row.cwd, status: row.status, updatedAt: row.updated_at })) };
    if (operation === "start") {
      const old = this.row(context.callId);
      if (old) return this.snapshot(this.owned(context, old.id));
      if (!this.capacity()) throw new Error("本机已有 4 个 Agent 会话运行，请先停止一个");
      const cwd = agentText(p.cwd, "cwd", 4096);
      if (!path.isAbsolute(cwd)) throw new Error("本地 Agent 工作目录须为目标电脑上的绝对路径");
      const real = realpathSync(cwd);
      if (!statSync(real).isDirectory()) throw new Error("本地 Agent 工作目录不存在");
      // callId also makes a confirmed start idempotent at the process boundary.
      const now = Date.now();
      this.db.prepare("INSERT INTO local_agent_sessions(id,binding_id,bot_id,task_id,agent,cwd,native_id,status,error,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,'starting',NULL,?,?)").run(context.callId, context.bindingId, context.botId, context.taskId, p.agent as string, real, now, now);
      this.db.prepare("DELETE FROM local_agent_sessions WHERE status NOT IN ('starting','running','waiting') AND id NOT IN(SELECT id FROM local_agent_sessions ORDER BY updated_at DESC LIMIT 50)").run();
      this.launch(this.row(context.callId)!, p.prompt as string);
      return this.snapshot(this.row(context.callId)!);
    }
    let row = this.owned(context, p.sessionId);
    if (operation === "status") {
      const after = Number(p.after ?? 0), waitMs = Number(p.waitMs ?? 0);
      if (waitMs && ["starting", "running"].includes(row.status) && !this.db.prepare("SELECT seq FROM local_agent_events WHERE session_id=? AND seq>? LIMIT 1").get(row.id, after))
        await new Promise<void>((resolve) => {
          const waiters = this.waiters.get(row.id) ?? new Set<() => void>();
          const wake = () => { clearTimeout(timer); waiters.delete(wake); if (!waiters.size) this.waiters.delete(row.id); resolve(); };
          const timer = setTimeout(wake, waitMs); waiters.add(wake); this.waiters.set(row.id, waiters);
        });
      row = this.owned(context, p.sessionId);
      return this.snapshot(row, after);
    }
    if (operation === "stop") {
      const live = this.live.get(row.id);
      if (live && !live.finished) await this.finish(live, "cancelled");
      else if (row.status === "starting") this.state(row.id, "cancelled");
      return this.snapshot(this.row(row.id)!);
    }
    if (operation === "send") {
      const live = this.live.get(row.id);
      if (live && !live.finished && !live.ready) throw new Error("本地 Agent 正在启动，请先查询 status");
      if ((!live || live.finished) && !row.native_id) throw new Error("此会话没有可恢复的 CLI 会话，请明确新建任务");
      if ((!live || live.finished) && !this.capacity()) throw new Error("本机已有 4 个 Agent 会话运行，请先停止一个");
      this.db.prepare("UPDATE local_agent_sessions SET task_id=? WHERE id=?").run(context.taskId, row.id);
      if (live && !live.finished) {
        this.event(row.id, "input", p.prompt as string);
        if (live.agent === "codex") {
          if (!live.turnId) throw new Error("Codex 尚未开始执行，请先查询 status");
          void this.rpc(live, "turn/steer", { threadId: row.native_id, expectedTurnId: live.turnId, input: [{ type: "text", text: p.prompt }] }).catch((error) => this.fail(live, error));
        } else this.write(live, this.claudeInput(live, row.native_id, p.prompt as string));
      } else { this.state(row.id, "starting"); this.launch(this.row(row.id)!, p.prompt as string); }
      return this.snapshot(this.row(row.id)!);
    }
    const live = this.live.get(row.id), preview = agentObject(p.request);
    const pending = live?.requests.get(String(preview.id));
    // The approval card must contain the original native request, not a model's
    // replacement description of what would be approved.
    if (!live || live.finished || !pending || canonical(pending.preview) !== canonical(preview)) throw new Error("CLI 确认请求已失效或内容不匹配，请重新查询 status");
    this.respond(live, pending, p.allow as boolean, object(p.answers));
    live.requests.delete(pending.preview.id);
    this.state(row.id, live.requests.size ? "waiting" : "running");
    return this.snapshot(this.row(row.id)!);
  }
  private async probe(agent: LocalAgentKind) {
    return new Promise<{ agent: LocalAgentKind; installed: boolean; version?: string; error?: string }>((resolve) => {
      let child: ReturnType<typeof spawnCli>;
      try { child = spawnCli(this.command(agent), ["--version"], { env: this.env(), stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() }); }
      catch (error) { resolve({ agent, installed: false, error: String(error) }); return; }
      let text = "", finished = false;
      const done = (installed: boolean, error?: string) => { if (finished) return; finished = true; clearTimeout(timer); resolve({ agent, installed, ...(installed ? { version: text.trim().slice(0, 200) } : { error }) }); };
      const timer = setTimeout(() => { void killCliTree(child, 100); done(false, "CLI 版本检测超时"); }, 3000);
      child.stdout.on("data", (chunk: Buffer) => { text = (text + chunk.toString("utf8")).slice(0, 1024); });
      child.stderr.resume(); child.stdin.end();
      child.once("error", (error) => done(false, error.message)); child.once("close", (code) => done(code === 0, "CLI 不可用，请在目标电脑安装并登录"));
    });
  }
  private launch(row: Session, prompt: string) {
    // A completed process may still be reaping helpers; never overlap its resume.
    const launch = async () => { await this.finishing.get(row.id); if (this.closed || this.closing || this.row(row.id)?.status !== "starting") return;
      const args = row.agent === "codex" ? ["app-server"] : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--replay-user-messages", "--permission-mode", "default", "--permission-prompt-tool=stdio", ...(row.native_id ? ["--resume", row.native_id] : [])];
      const child = spawnCli(this.command(row.agent), args, { cwd: row.cwd, env: this.env(), stdio: ["pipe", "pipe", "pipe"] });
      const live: Live = { id: row.id, agent: row.agent, child, ready: false, finished: false, inputs: new Set(), stderr: "", rpc: new Map(), requests: new Map(),
        timer: setTimeout(() => { void this.finish(live, "failed", "本地 Agent 运行已达 2 小时上限"); }, this.options.maxRunMs ?? 2 * 60 * 60_000) };
      live.timer.unref(); this.live.set(row.id, live);
      let buffer = ""; child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (live.finished) return;
        buffer += chunk;
        if (buffer.length > 1_000_000) { this.fail(live, new Error("CLI 输出超出单条消息上限")); return; }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try { this.message(live, object(JSON.parse(line))); } catch (error) { this.fail(live, error); break; }
        }
      });
      child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { live.stderr = (live.stderr + chunk).slice(-8000); });
      child.once("error", (error) => this.fail(live, error));
      child.once("close", (code, signal) => {
        if (!live.finished) this.fail(live, new Error(`CLI 在完成事件前退出 (${code ?? signal})${live.stderr ? ": " + live.stderr : ""}`));
      });
      this.event(row.id, "input", prompt);
      try {
        if (row.agent === "codex") {
          await this.rpc(live, "initialize", { clientInfo: { name: "nexbot_local_agent", title: "NexBot", version: "1.0.0" }, capabilities: {} });
          this.write(live, { method: "initialized", params: {} });
          const result = await this.rpc(live, row.native_id ? "thread/resume" : "thread/start", { ...(row.native_id ? { threadId: row.native_id } : {}), cwd: row.cwd, sandbox: "workspace-write", approvalPolicy: "on-request" });
          const nativeId = agentText(object(result.thread).id, "CLI sessionId", 200);
          this.db.prepare("UPDATE local_agent_sessions SET native_id=? WHERE id=?").run(nativeId, row.id);
          const turn = await this.rpc(live, "turn/start", { threadId: nativeId, input: [{ type: "text", text: prompt }] });
          live.turnId = agentText(object(turn.turn).id, "CLI turnId", 200);
        } else {
          await this.rpc(live, "initialize", { subtype: "initialize", hooks: {}, sdkMcpServers: [] });
          this.write(live, this.claudeInput(live, row.native_id, prompt));
        }
        live.ready = true;
        if (!live.finished) this.state(row.id, live.requests.size ? "waiting" : "running");
      } catch (error) { this.fail(live, error); }
    };
    void launch().catch((error) => { if (!this.closed) this.state(row.id, "failed", String(error)); });
  }
  private claudeInput(live: Live, sessionId: string | null, text: string) { const uuid = randomUUID(); live.inputs.add(uuid); return { type: "user", uuid, session_id: sessionId ?? "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } }; }
  private write(live: Live, packet: ObjectValue) {
    if (live.finished || live.child.stdin.destroyed || !live.child.stdin.writable) throw new Error("CLI 输入通道已关闭");
    live.child.stdin.write(JSON.stringify(packet) + "\n");
  }
  private rpc(live: Live, method: string, params: ObjectValue) {
    const id = randomUUID();
    return new Promise<ObjectValue>((resolve, reject) => {
      const timer = setTimeout(() => { live.rpc.delete(id); reject(new Error(`CLI ${method} 响应超时`)); }, 15_000);
      live.rpc.set(id, { resolve, reject, timer });
      try { this.write(live, live.agent === "codex" ? { id, method, params } : { type: "control_request", request_id: id, request: params }); }
      catch (error) { live.rpc.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  private message(live: Live, packet: ObjectValue) {
    if (live.finished) return;
    const response = live.agent === "codex" ? packet : object(packet.response);
    const rpcId = live.agent === "codex" ? packet.id : response.request_id;
    const rpc = typeof rpcId === "string" ? live.rpc.get(rpcId) : undefined;
    if (rpc && (live.agent === "codex" ? !packet.method : packet.type === "control_response")) {
      live.rpc.delete(String(rpcId)); clearTimeout(rpc.timer);
      if (response.error) rpc.reject(new Error(String(object(response.error).message ?? response.error)));
      else rpc.resolve(object(live.agent === "codex" ? packet.result : response.response));
      return;
    }
    if (live.agent === "codex") this.codexMessage(live, packet);
    else this.claudeMessage(live, packet);
  }
  private request(live: Live, wireId: string | number, kind: string, details: ObjectValue) {
    if (JSON.stringify(details).length > 32_000 || live.requests.size >= 16) throw new Error("CLI 确认请求过大或过多，任务已停止");
    const preview = { id: randomUUID(), kind, details };
    live.requests.set(preview.id, { wireId, preview }); this.state(live.id, "waiting");
  }
  private codexMessage(live: Live, packet: ObjectValue) {
    const method = String(packet.method ?? ""), p = object(packet.params);
    const row = this.row(live.id)!;
    if (p.threadId !== undefined && p.threadId !== row.native_id) return;
    if (packet.id !== undefined && packet.method) {
      const kinds = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "tool/requestUserInput", "mcpServer/elicitation/request"];
      if (kinds.includes(method) && (typeof packet.id === "string" || typeof packet.id === "number")) this.request(live, packet.id, method, p);
      else this.write(live, { id: packet.id, error: { code: -32601, message: "NexBot does not support this local CLI request" } });
      return;
    }
    if (method === "turn/started") live.turnId = String(object(p.turn).id ?? "");
    if (method === "serverRequest/resolved") {
      for (const [id, pending] of live.requests) if (pending.wireId === p.requestId) live.requests.delete(id);
      if (!live.requests.size && !live.finished) this.state(live.id, "running");
    }
    if (["item/agentMessage/delta", "item/commandExecution/outputDelta"].includes(method) && typeof p.delta === "string") this.event(live.id, method === "item/agentMessage/delta" ? "output" : "tool", p.delta);
    if (method === "item/started" || method === "item/completed") {
      const item = object(p.item);
      if (method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") this.event(live.id, "result", item.text);
      if (item.type !== "agentMessage") this.event(live.id, "tool", JSON.stringify({ type: item.type, status: item.status, command: item.command, changes: item.changes }).slice(0, 8000));
    }
    if (method === "turn/completed") {
      const turn = object(p.turn), status = turn.status;
      void this.finish(live, status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "failed", status === "failed" ? String(object(turn.error).message ?? "Codex 任务失败") : undefined);
    }
    if (method === "error" && p.willRetry !== true) this.fail(live, new Error(String(object(p.error).message ?? "Codex 运行错误")));
  }
  private claudeMessage(live: Live, packet: ObjectValue) {
    // Nested agents share the stream. Their output/session/result must not
    // replace the parent conversation or settle its still-running turn.
    if (typeof packet.parent_tool_use_id === "string" && packet.parent_tool_use_id && !["control_request", "control_cancel_request"].includes(String(packet.type))) return;
    if (packet.type === "system" && packet.subtype === "init") {
      const nativeId = agentText(packet.session_id, "CLI sessionId", 200), previous = this.row(live.id)!.native_id;
      if (previous && previous !== nativeId) throw new Error("CLI 返回的会话 ID 不匹配，未恢复到原会话");
      this.db.prepare("UPDATE local_agent_sessions SET native_id=? WHERE id=?").run(nativeId, live.id);
    }
    if (packet.type === "user" && typeof packet.uuid === "string") live.inputs.delete(packet.uuid);
    if (packet.type === "control_request") {
      const request = object(packet.request);
      if (request.subtype === "can_use_tool" && typeof packet.request_id === "string") this.request(live, packet.request_id, "can_use_tool", request);
      else this.write(live, { type: "control_response", response: { subtype: "error", request_id: packet.request_id, error: "Unsupported local CLI request" } });
    }
    if (packet.type === "control_cancel_request") {
      for (const [id, pending] of live.requests) if (pending.wireId === packet.request_id) live.requests.delete(id);
      if (!live.requests.size) this.state(live.id, "running");
    }
    if (packet.type === "stream_event") {
      const delta = object(object(packet.event).delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") this.event(live.id, "output", delta.text);
    }
    if (packet.type === "assistant") {
      const content = object(packet.message).content;
      if (Array.isArray(content)) for (const entry of content) {
        const block = object(entry);
        if (block.type === "tool_use") this.event(live.id, "tool", JSON.stringify({ name: block.name, input: block.input }).slice(0, 8000));
      }
    }
    if (packet.type === "result") {
      if (typeof packet.result === "string") this.event(live.id, "result", packet.result);
      if (packet.is_error || packet.subtype !== "success") this.fail(live, new Error(String(packet.result ?? (Array.isArray(packet.errors) ? packet.errors.join("; ") : "Claude Code 任务失败"))));
      else if (!live.inputs.size && !(typeof packet.queued_turn_count === "number" && packet.queued_turn_count > 0)) void this.finish(live, "completed");
    }
  }
  private respond(live: Live, pending: Pending, allow: boolean, answers: ObjectValue) {
    const { kind, details } = pending.preview;
    if (live.agent === "claude") {
      this.write(live, { type: "control_response", response: { subtype: "success", request_id: pending.wireId,
        response: allow ? { behavior: "allow", updatedInput: details.tool_name === "AskUserQuestion" ? { ...object(details.input), answers: Object.fromEntries(Object.entries(answers).map(([question, values]) => [question, (values as string[]).join(", ")])) } : details.input } : { behavior: "deny", message: "用户拒绝了本次操作" } } }); return;
    }
    let result: ObjectValue;
    if (kind === "item/permissions/requestApproval") result = { permissions: allow ? details.permissions : {}, scope: "turn" };
    else if (kind.endsWith("requestUserInput")) result = { answers: allow ? Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])) : {} };
    else if (kind === "mcpServer/elicitation/request") {
      if (allow) throw new Error("此 CLI 确认需在本机完成；可拒绝或停止任务");
      result = { action: "decline", content: null };
    } else result = { decision: allow ? "accept" : "decline" };
    this.write(live, { id: pending.wireId, result });
  }
  private fail(live: Live, error: unknown) { if (!live.finished) void this.finish(live, "failed", error instanceof Error ? error.message : String(error)); }
  private finish(live: Live, status: string, error?: string): Promise<boolean> {
    if (live.finished) return this.finishing.get(live.id) ?? Promise.resolve(true);
    live.finished = true; clearTimeout(live.timer); live.requests.clear();
    for (const pending of live.rpc.values()) { clearTimeout(pending.timer); pending.reject(new Error("CLI 会话已结束")); } live.rpc.clear();
    this.state(live.id, status, error);
    // Keep the launcher alive until taskkill /T has captured its descendants.
    // Ending stdin first lets npm's Codex launcher exit before Windows can
    // find the native app-server below it, leaving its pipes/files open.
    // Windows tree enumeration can take over a second for a real CLI and its
    // startup helpers. Use the shared bounded stop deadline before resuming.
    const stopping = killCliTree(live.child);
    this.finishing.set(live.id, stopping);
    void stopping.then((stopped) => {
      if (this.live.get(live.id) === live) this.live.delete(live.id);
      if (this.finishing.get(live.id) === stopping) this.finishing.delete(live.id);
      if (!stopped && !this.closed) this.state(live.id, "interrupted", "未能确认 CLI 进程树停止，请在本机核实");
    });
    return stopping;
  }
  async cancelTask(bindingId: string, taskId: string) {
    for (const row of this.db.prepare("SELECT id FROM local_agent_sessions WHERE binding_id=? AND task_id=? AND status='starting'").all(bindingId, taskId))
      if (!this.live.has(String(row.id))) this.state(String(row.id), "cancelled");
    await Promise.all([...this.live.values()].filter((live) => { const row = this.row(live.id); return row?.binding_id === bindingId && row.task_id === taskId; }).map((live) => this.finish(live, "cancelled")));
  }
  async close() {
    this.closing = true;
    for (const row of this.db.prepare("SELECT id FROM local_agent_sessions WHERE status='starting'").all())
      if (!this.live.has(String(row.id))) this.state(String(row.id), "cancelled");
    await Promise.all([...this.live.values()].map((live) => this.finish(live, "cancelled")));
    await Promise.all(this.finishing.values());
    for (const waiters of this.waiters.values()) for (const wake of waiters) wake();
    this.closed = true;
  }
}
