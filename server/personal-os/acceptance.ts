import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { CoreStore } from './store.ts';

export const ACCEPTANCE_LIMITS = Object.freeze({ calls: 120, cnyMicros: 50_000_000, maxOutput: 4096 });
// Trusted operator configuration only; never accepted from an HTTP request. This is
// a verified all-inclusive upper price per physical request, NOT an estimated price.
export interface AcceptanceQuote {
  fingerprint: string; currency: 'CNY'; unit: 'request-upper-bound'; boundCnyMicros: number;
  maxInputTokens: number; maxOutputTokens: 4096; supportsImages: boolean; validUntil: number; evidence: string;
}
export interface AcceptanceScript {
  root: string; deviceId: string; command: string;
  executable: string; args: string[]; projectRootIndex: number;
  runtimeExecutables?: string[];
  userDirectories?: Partial<Record<'USERPROFILE' | 'LOCALAPPDATA' | 'APPDATA' | 'HOME', string>>;
  risk: 'standard' | 'dangerous';
  preauthorized?: true;
  allowedBotNames?: string[];
  timeoutMs?: number;
  files: Array<{ path: string; sha256: string; readable?: true }>;
  // The executor/sandbox is independently provisioned; Core does not infer these
  // guarantees from a shell command or grant unrestricted exec to create them.
  networkDenied: boolean; mediaBudgetEvidence?: string; credentialsExcluded: true; immutable: true;
}
export interface AcceptancePrepaidQuota {
  mode: 'prepaid-quota'; root: string; fingerprint: string;
  authorization: { approved: true; evidence: string };
  calls: 120; maxOutputTokens: 4096; maxInputTokens: number;
  supportsImages: boolean; validUntil: number;
}
export interface AcceptanceOptions { quotes?: AcceptanceQuote[]; prepaidQuotas?: AcceptancePrepaidQuota[]; scripts?: AcceptanceScript[] }
/** Per-workspace operator policy, absent by default. Never uploaded through API.
 * Invalid policy disables only acceptance, leaving ordinary assistants untouched. */
export function loadAcceptanceOptions(dir: string): AcceptanceOptions {
  const file = path.join(dir, 'acceptance-policy.json');
  try {
    if (!existsSync(file) || statSync(file).size > 256_000) return {};
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return { quotes: Array.isArray(value.quotes) ? value.quotes : [], prepaidQuotas: Array.isArray(value.prepaidQuotas) ? value.prepaidQuotas : [], scripts: Array.isArray(value.scripts) ? value.scripts : [] };
  } catch { return {}; }
}
export const acceptanceSchema = `
CREATE TABLE acceptance_scopes (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
 root TEXT NOT NULL UNIQUE, source_model TEXT NOT NULL, provider TEXT NOT NULL, fingerprint TEXT NOT NULL,
 connection_version INTEGER NOT NULL, supplier_host TEXT NOT NULL,
 quote_json TEXT, scripts_json TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 120),
 held_micros INTEGER NOT NULL DEFAULT 0 CHECK(held_micros>=0),
 charged_micros INTEGER NOT NULL DEFAULT 0 CHECK(charged_micros>=0),
 created_at INTEGER NOT NULL, CHECK(held_micros+charged_micros<=50000000)
) STRICT;
CREATE TABLE acceptance_members (
 bot_id TEXT PRIMARY KEY REFERENCES bots(id), scope_id TEXT NOT NULL REFERENCES acceptance_scopes(id),
 conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id)
) STRICT;
CREATE TABLE acceptance_attempts (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES acceptance_scopes(id), bot_id TEXT NOT NULL REFERENCES bots(id),
 request_key TEXT NOT NULL UNIQUE, reserved_micros INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('dispatched','succeeded','unknown')),
 created_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE TABLE acceptance_conversations (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), bot_id TEXT NOT NULL REFERENCES bots(id),
 scope_id TEXT NOT NULL REFERENCES acceptance_scopes(id)
) STRICT;
`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const acceptancePrepaidSchema = `CREATE TABLE acceptance_prepaid_scopes (
 scope_id TEXT PRIMARY KEY REFERENCES acceptance_scopes(id), authorization_json TEXT NOT NULL,
 quota_error TEXT
) STRICT;`;
const validInt = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export function scopeRoot(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error('验收目录无效');
  const paths = /^[A-Za-z]:[\\/]/.test(value) ? path.win32 : path.posix;
  if (!paths.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error('验收目录须为绝对新目录');
  const root = paths.normalize(value).replace(/[\\/]$/, '');
  if (root === paths.parse(root).root.replace(/[\\/]$/, '')) throw new Error('不能使用磁盘或文件系统根目录');
  return paths === path.win32 ? root.toLowerCase() : root;
}

export class AcceptanceBudget {
  options: AcceptanceOptions = {};
  constructor(readonly store: CoreStore) {
    // A process restart can never replay a previously issued network permission.
    store.run("UPDATE acceptance_scopes SET stopped=1 WHERE id IN (SELECT scope_id FROM acceptance_attempts WHERE status IN ('dispatched','unknown'))");
    store.run("UPDATE acceptance_attempts SET status='unknown',finished_at=? WHERE status='dispatched'", Date.now());
  }
  member(botId: string) { return this.store.get('SELECT * FROM acceptance_members WHERE bot_id=?', botId); }
  scope(scopeId: string) {
    const row = this.store.get('SELECT * FROM acceptance_scopes WHERE id=? AND workspace_id=? AND owner_user_id=?', scopeId, this.store.workspace, this.store.owner);
    if (!row) throw new Error('验收范围不存在');
    return row;
  }
  model(botId: string) {
    if (!this.store.get("SELECT id FROM bots WHERE id=? AND status='active' AND workspace_id=? AND owner_user_id=?", botId, this.store.workspace, this.store.owner)) throw new Error('助手不存在');
    const config = this.store.config();
    if (!config?.configured) throw new Error('模型尚未配置');
    const model = String(this.store.botModelSelection(botId)?.selected_model || config.default_model);
    const provider = String(config.provider_id);
    const limits = this.store.modelLimitSettings({ provider, endpoint: String(config.endpoint), model });
    const version = Number(this.store.get("SELECT version FROM model_connections WHERE id='default'")?.version);
    const supplier = new URL(String(config.endpoint)).hostname;
    return { model, provider, limits, supplier, connectionVersion: version, endpoint: String(config.endpoint), fingerprint: digest(JSON.stringify([provider, config.endpoint, version, model, limits.contextWindow])) };
  }
  sourceModel(sourceName: unknown, deviceId?: unknown) {
    if (sourceName !== 'my_win') throw new Error('仅允许读取 my_win 的模型选择');
    const sources = this.store.all("SELECT id FROM bots WHERE name='my_win' AND status='active' AND workspace_id=? AND owner_user_id=?", this.store.workspace, this.store.owner);
    if (sources.length !== 1) throw new Error('my_win 不存在或不唯一');
    const selected = this.model(String(sources[0].id));
    const device = typeof deviceId === 'string' && deviceId.length <= 100 ? this.store.get("SELECT d.id,d.name,d.platform,g.scope_json FROM devices d LEFT JOIN device_local_grants g ON g.device_id=d.id AND g.local_grant_id='shared' AND g.status='active' WHERE d.id=? AND d.workspace_id=? AND d.owner_user_id=? AND d.status='bound'", deviceId, this.store.workspace, this.store.owner) : undefined;
    const grant = device?.scope_json ? JSON.parse(String(device.scope_json)) : {};
    // The hostname identifies the configured supplier connection; it is not a
    // claim about a brand or its prices. URL path/query/userinfo never escape.
    return { sourceId: String(sources[0].id), workspaceId: this.store.workspace, model: selected.model, protocol: selected.provider, supplier: selected.supplier, connectionVersion: selected.connectionVersion, revision: selected.fingerprint, contextWindow: selected.limits.contextWindow,
      device: device ? { id: String(device.id), name: String(device.name), platform: String(device.platform), hostname: String(grant.identity?.hostname ?? ''), acceptanceExec: grant.acceptanceExec === 1, exec: grant.exec === true } : null };
  }
  private quoteValid(quote: AcceptanceQuote | undefined, selected: ReturnType<AcceptanceBudget['model']>) {
    return !!quote && quote.fingerprint === selected.fingerprint && quote.currency === 'CNY' && quote.unit === 'request-upper-bound'
      && validInt(quote.boundCnyMicros) && quote.boundCnyMicros <= ACCEPTANCE_LIMITS.cnyMicros
      && validInt(quote.maxInputTokens) && quote.maxInputTokens >= selected.limits.contextWindow
      && quote.maxOutputTokens === 4096 && typeof quote.supportsImages === 'boolean'
      && validInt(quote.validUntil) && quote.validUntil > Date.now() && typeof quote.evidence === 'string' && quote.evidence.trim().length > 0;
  }
  private prepaidValid(policy: AcceptancePrepaidQuota | undefined, selected: ReturnType<AcceptanceBudget['model']>, root: string) {
    try {
      return !!policy && policy.mode === 'prepaid-quota' && scopeRoot(policy.root) === root && policy.fingerprint === selected.fingerprint
        && policy.authorization?.approved === true && typeof policy.authorization.evidence === 'string'
        && policy.authorization.evidence.trim().length > 0 && policy.authorization.evidence.length <= 8000
        && policy.calls === 120 && policy.maxOutputTokens === 4096
        && validInt(policy.maxInputTokens) && policy.maxInputTokens >= selected.limits.contextWindow
        && typeof policy.supportsImages === 'boolean' && validInt(policy.validUntil) && policy.validUntil > Date.now();
    } catch { return false; }
  }
  prepare(data: Record<string, unknown>, ensure: (botId: string) => void) {
    const source = this.sourceModel('my_win');
    if (data.sourceId !== source.sourceId || data.sourceRevision !== source.revision) throw new Error('模型来源或连接版本已变化');
    if (!Array.isArray(data.names) || data.names.length !== 5 || data.names.some(name => typeof name !== 'string' || !name.trim() || name.length > 80) || new Set(data.names.map(name => String(name).trim())).size !== 5) throw new Error('需要五个不同的新岗位名称');
    if (Object.keys(data).some(key => !['sourceId', 'sourceRevision', 'names', 'root'].includes(key))) throw new Error('验收参数无效，预算不能通过客户端修改');
    const root = scopeRoot(data.root), selected = this.model(String(source.sourceId));
    const quote = this.options.quotes?.find(item => this.quoteValid(item, selected));
    const prepaid = this.options.prepaidQuotas?.find(item => this.prepaidValid(item, selected, root));
    const scripts = (this.options.scripts ?? []).filter(script => scopeRoot(script.root) === root && (script.networkDenied === true || (typeof script.mediaBudgetEvidence === 'string' && script.mediaBudgetEvidence.trim().length > 0)) && script.credentialsExcluded === true && script.immutable === true
      && (script.allowedBotNames === undefined || (Array.isArray(script.allowedBotNames) && script.allowedBotNames.length > 0 && script.allowedBotNames.length <= 5 && script.allowedBotNames.every(name => typeof name === 'string' && (data.names as string[]).some(value => value.trim() === name)))));
    const scopeId = randomUUID();
    this.store.transaction(() => {
      // Roots are exclusive across scopes, including ancestors, so a later scope
      // cannot run an approved script inside an earlier acceptance workspace.
      for (const prior of this.store.all('SELECT root FROM acceptance_scopes')) if (root === prior.root || root.startsWith(String(prior.root) + '/') || root.startsWith(String(prior.root) + '\\') || String(prior.root).startsWith(root + '/') || String(prior.root).startsWith(root + '\\')) throw new Error('验收目录已被使用或重叠');
      this.store.insert('acceptance_scopes', { id: scopeId, ...this.store.scope(), root, source_model: selected.model, provider: selected.provider, fingerprint: selected.fingerprint, connection_version: selected.connectionVersion, supplier_host: selected.supplier, quote_json: quote ? JSON.stringify(quote) : null, scripts_json: JSON.stringify(scripts), created_at: Date.now() });
      if (prepaid) this.store.insert('acceptance_prepaid_scopes', { scope_id: scopeId, authorization_json: JSON.stringify(prepaid) });
      for (const name of data.names as string[]) {
        if (this.store.get('SELECT id FROM bots WHERE name=?', name.trim())) throw new Error('验收岗位名称已存在');
        const botId = this.store.createBot(name.trim(), `验收工作目录：${root}`);
        this.store.run('INSERT INTO agent_model_settings(bot_id,provider,endpoint,model,version) VALUES(?,?,?,?,1)', botId, selected.provider, selected.endpoint, selected.model);
        const conversationId = this.store.createConversation(botId, '隔离验收');
        this.store.insert('acceptance_members', { bot_id: botId, scope_id: scopeId, conversation_id: conversationId });
        this.store.run('UPDATE bot_policies SET policy_json=? WHERE bot_id=?', JSON.stringify({ tools: ['agent.directory', 'agent.delegate', 'device.inventory', 'device.info', 'device.read', 'device.exec', 'attachment.read', 'html.render', 'tool.search'] }), botId);
        this.store.run('UPDATE assistant_memory_settings SET enabled=0 WHERE bot_id=?', botId);
        ensure(botId);
        this.store.run('INSERT INTO assistant_conversations(bot_id,conversation_id) VALUES(?,?)', botId, conversationId);
      }
      this.store.audit('acceptance.prepare', 'acceptance_scope', scopeId, { members: 5, standingScripts: scripts.filter(script => script.preauthorized === true).map(script => ({ command: script.command, deviceId: script.deviceId, files: script.files })) });
    });
    return this.status(scopeId);
  }
  ready(botId: string) {
    const member = this.member(botId);
    if (!member) return;
    const scope = this.scope(String(member.scope_id));
    if (scope.stopped) throw new Error('验收范围已停止');
    const selected = this.model(botId);
    if (scope.fingerprint !== selected.fingerprint || scope.source_model !== selected.model) throw new Error('验收模型连接已变化');
    const quote = scope.quote_json ? JSON.parse(String(scope.quote_json)) as AcceptanceQuote : undefined;
    const prepaidRow = this.store.get('SELECT * FROM acceptance_prepaid_scopes WHERE scope_id=?', scope.id);
    const prepaid = prepaidRow ? JSON.parse(String(prepaidRow.authorization_json)) as AcceptancePrepaidQuota : undefined;
    if (prepaidRow) {
      if (!this.prepaidValid(prepaid, selected, String(scope.root))) throw new Error('验收套餐授权无效或已过期');
    } else if (!this.quoteValid(quote, selected)) throw new Error('验收尚未就绪：缺少有效的人民币计费上界');
    if (Number(scope.attempts) >= 120 || (!prepaidRow && Number(scope.held_micros) + Number(scope.charged_micros) + quote!.boundCnyMicros > ACCEPTANCE_LIMITS.cnyMicros)) throw new Error('验收共享预算已用完');
    return { member, scope, quote, prepaid, supportsImages: prepaid ? prepaid.supportsImages : quote!.supportsImages };
  }
  status(scopeId: string) {
    const scope = this.scope(scopeId);
    const members = this.store.all('SELECT m.bot_id id,m.conversation_id,b.name FROM acceptance_members m JOIN bots b ON b.id=m.bot_id WHERE m.scope_id=?', scopeId);
    let reason: string | null = null;
    try { this.ready(String(members[0]?.id)); } catch (error) { reason = error instanceof Error ? error.message : '验收不可用'; }
    const prepaid = this.store.get('SELECT quota_error FROM acceptance_prepaid_scopes WHERE scope_id=?', scope.id);
    return { scopeId, ready: !reason, reason, budgetMode: prepaid ? 'prepaid-quota' : 'cny-upper-bound', quotaError: prepaid?.quota_error ?? null,
      limits: { ...ACCEPTANCE_LIMITS, cnyMicros: prepaid ? null : ACCEPTANCE_LIMITS.cnyMicros }, model: { id: scope.source_model, protocol: scope.provider, supplier: scope.supplier_host, connectionVersion: scope.connection_version }, attempts: scope.attempts, heldCnyMicros: prepaid ? null : scope.held_micros, chargedUpperCnyMicros: prepaid ? null : scope.charged_micros, members,
      tasks: this.store.all('SELECT t.id,t.bot_id,t.conversation_id,t.status,t.result_summary FROM tasks t JOIN acceptance_members m ON m.bot_id=t.bot_id WHERE m.scope_id=? ORDER BY t.created_at DESC LIMIT 100', scopeId),
      reports: this.store.all('SELECT a.id,a.bot_id,a.task_id,a.seq,a.role,a.kind,a.content FROM agent_messages a JOIN acceptance_members m ON m.bot_id=a.bot_id WHERE m.scope_id=? ORDER BY a.created_at DESC,a.seq DESC LIMIT 100', scopeId),
      operations: this.store.all('SELECT c.id,c.task_id,c.bot_id,c.tool_name,c.status FROM tool_calls c JOIN acceptance_members m ON m.bot_id=c.bot_id WHERE m.scope_id=? ORDER BY c.created_at DESC LIMIT 100', scopeId) };
  }
  assertMember(scopeId: string, botId: string) {
    this.scope(scopeId);
    if (this.member(botId)?.scope_id !== scopeId) throw new Error('助手不属于此验收范围');
  }
  reserve(botId: string, requestKey: string, payload: unknown) {
    return this.store.transaction(() => {
      const ready = this.ready(botId);
      if (!ready) return undefined;
      const { scope, quote, prepaid, supportsImages } = ready;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('验收请求格式无效');
      const body = payload as Record<string, unknown>;
      const output = body.max_completion_tokens ?? body.max_tokens;
      if (body.model !== scope.source_model || !validInt(output) || output > 4096 || (body.max_tokens !== undefined && (!validInt(body.max_tokens) || body.max_tokens > 4096)) || (body.max_completion_tokens !== undefined && (!validInt(body.max_completion_tokens) || body.max_completion_tokens > 4096)) || Number(body.n ?? 1) !== 1) throw new Error('验收请求模型或输出上限无效');
      const images = /"(?:image_url|input_image|image)"\s*:|"type"\s*:\s*"(?:image|image_url|input_image)"/.test(JSON.stringify(body));
      if (images && !supportsImages) throw new Error('验收预算尚未覆盖图片输入');
      if (this.store.get('SELECT id FROM acceptance_attempts WHERE request_key=?', requestKey)) throw new Error('验收请求已签发，禁止重复发送');
      // Prepaid scopes use only the durable attempts counter. The legacy CNY
      // columns remain unused, and are always projected as null for this mode.
      const reserved = prepaid ? 0 : quote!.boundCnyMicros;
      const updated = this.store.run('UPDATE acceptance_scopes SET attempts=attempts+1,held_micros=held_micros+? WHERE id=? AND stopped=0 AND attempts<120 AND held_micros+charged_micros+?<=50000000', reserved, scope.id, reserved);
      if (updated.changes !== 1) throw new Error('验收共享预算已用完');
      const attemptId = randomUUID();
      this.store.insert('acceptance_attempts', { id: attemptId, scope_id: scope.id, bot_id: botId, request_key: requestKey, reserved_micros: reserved, status: 'dispatched', created_at: Date.now() });
      return attemptId;
    });
  }
  quotaError(botId: string, requestKey: string) {
    const member = this.member(botId);
    if (!member) return;
    this.store.transaction(() => {
      if (!this.store.get('SELECT scope_id FROM acceptance_prepaid_scopes WHERE scope_id=?', member.scope_id)) return;
      if (!this.store.get('SELECT id FROM acceptance_attempts WHERE scope_id=? AND bot_id=? AND request_key=?', member.scope_id, botId, requestKey)) throw new Error('套餐请求许可失效');
      this.store.run('UPDATE acceptance_prepaid_scopes SET quota_error=? WHERE scope_id=?', '套餐配额不足或被限流，已停止新增请求', member.scope_id);
      this.store.run('UPDATE acceptance_scopes SET stopped=1 WHERE id=?', member.scope_id);
    });
  }
  settle(attemptId: string, succeeded: boolean) {
    this.store.transaction(() => {
      const attempt = this.store.get("SELECT * FROM acceptance_attempts WHERE id=? AND status='dispatched'", attemptId);
      if (!attempt) return;
      this.store.run('UPDATE acceptance_attempts SET status=?,finished_at=? WHERE id=?', succeeded ? 'succeeded' : 'unknown', Date.now(), attempt.id);
      // Full quoted upper bound is conservatively charged on success. No cost is
      // claimed to be measured. Failure/unknown retains the entire reservation.
      if (succeeded) this.store.run('UPDATE acceptance_scopes SET held_micros=held_micros-?,charged_micros=charged_micros+? WHERE id=?', attempt.reserved_micros, attempt.reserved_micros, attempt.scope_id);
    });
  }
  unknownTask(taskId: string) {
    for (const attempt of this.store.all("SELECT a.id FROM acceptance_attempts a JOIN model_invocations m ON m.id=a.request_key JOIN task_runs r ON r.id=m.run_id WHERE r.task_id=? AND a.status='dispatched'", taskId)) this.settle(String(attempt.id), false);
  }
  denyAuxiliary(botId: string) { if (this.member(botId)) throw new Error('此验收范围禁止未审计的辅助推理'); }
  assertTool(botId: string, args: Record<string, unknown>) {
    const member = this.member(botId);
    if (!member && args.action === 'agent.delegate' && typeof args.botId === 'string' && this.member(args.botId)) throw new Error('禁止跨验收范围委派');
    if (!member) return;
    const scope = this.scope(String(member.scope_id));
    if (scope.stopped) throw new Error('验收范围已停止');
    const action = String(args.action);
    if (['device.inventory', 'device.info', 'tool.search', 'html.render'].includes(action)) return;
    if (action === 'agent.directory') return;
    if (action === 'agent.delegate' && args.topic === undefined && typeof args.botId === 'string' && this.member(args.botId)?.scope_id === member.scope_id) return;
    if (action === 'attachment.read' && typeof args.attachmentId === 'string' && this.store.get('SELECT id FROM chat_attachments WHERE id=? AND bot_id=? AND message_id IS NOT NULL', args.attachmentId, botId)) return;
    if (action === 'device.exec' || action === 'device.read') {
      if (action === 'device.exec') this.execution(botId, args); else this.reading(botId, args);
      const grant = this.store.get("SELECT scope_json FROM device_local_grants WHERE device_id=? AND status='active' AND local_grant_id='shared'", String(args.deviceId));
      if (grant && JSON.parse(String(grant.scope_json)).acceptanceExec !== 1) throw new Error('设备尚不支持受限验收脚本，请先升级设备执行器');
      return;
    }
    throw new Error('此验收范围禁止该工具或跨范围访问');
  }
  execution(botId: string, args: Record<string, unknown>) {
    const member = this.member(botId);
    if (!member || args.action !== 'device.exec') return undefined;
    const scope = this.scope(String(member.scope_id));
    const scripts = JSON.parse(String(scope.scripts_json)) as AcceptanceScript[];
    const script = scripts.find(item => item.command === args.command && item.deviceId === args.deviceId);
    if (script?.allowedBotNames !== undefined && (!Array.isArray(script.allowedBotNames) || !script.allowedBotNames.includes(String(this.store.get('SELECT name FROM bots WHERE id=?', botId)?.name)))) throw new Error('此岗位未获授权执行该验收脚本');
    if (!script || !['standard', 'dangerous'].includes(script.risk) || args.risk !== script.risk || !Array.isArray(script.args) || script.args.some(arg => typeof arg !== 'string') || !Number.isSafeInteger(script.projectRootIndex)
      || scopeRoot(script.args[script.projectRootIndex]) !== scope.root || !Array.isArray(script.files) || !script.files.length
      || !script.files.some(file => file.path === script.executable) || script.files.some(file => !/^[a-f0-9]{64}$/i.test(file.sha256))) throw new Error('验收仅允许已审阅并绑定目录的精确脚本');
    const timeoutMs = script.timeoutMs ?? 20000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('验收脚本超时须在一小时以内');
    return { version: 1 as const, scopeId: String(scope.id), root: String(scope.root), executable: script.executable, args: script.args, files: script.files, timeoutMs,
      ...(script.runtimeExecutables ? { runtimeExecutables: script.runtimeExecutables } : {}), ...(script.userDirectories ? { userDirectories: script.userDirectories } : {}) };
  }
  reading(botId: string, args: Record<string, unknown>) {
    const member = this.member(botId);
    if (!member || args.action !== 'device.read') return undefined;
    const scope = this.scope(String(member.scope_id));
    const scripts = JSON.parse(String(scope.scripts_json)) as AcceptanceScript[];
    const file = scripts.filter(script => script.deviceId === args.deviceId).flatMap(script => script.files ?? []).find(item => item.readable === true && item.path === args.path && /^[a-f0-9]{64}$/i.test(item.sha256));
    if (!file) throw new Error('验收仅允许读取清单中锁定哈希的脚本');
    const offset = args.offset ?? 0, limit = args.limit ?? 24000;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 24000) throw new Error('验收文本分页范围无效');
    return { version: 1 as const, path: file.path, sha256: file.sha256, offset: Number(offset), limit: Number(limit) };
  }
  preauthorized(botId: string, args: Record<string, unknown>) {
    const member = this.member(botId);
    if (!member || args.action !== 'device.exec') return false;
    this.assertTool(botId, args);
    const scripts = JSON.parse(String(this.scope(String(member.scope_id)).scripts_json)) as AcceptanceScript[];
    return scripts.some(script => script.command === args.command && script.deviceId === args.deviceId && script.preauthorized === true);
  }
  bindDelegation(sender: string, receiver: string, conversationId: string) {
    const member = this.member(sender);
    if (!member) { if (this.member(receiver)) throw new Error('禁止跨验收范围委派'); return; }
    this.assertMember(String(member.scope_id), receiver);
    this.store.insert('acceptance_conversations', { conversation_id: conversationId, bot_id: receiver, scope_id: member.scope_id });
  }
  ownsConversation(botId: string, conversationId: string) {
    const member = this.member(botId);
    return !member || member.conversation_id === conversationId || !!this.store.get('SELECT conversation_id FROM acceptance_conversations WHERE conversation_id=? AND bot_id=? AND scope_id=?', conversationId, botId, member.scope_id);
  }
  sameDirectory(botId: string, peerId: string) {
    const member = this.member(botId);
    return !member || this.member(peerId)?.scope_id === member.scope_id;
  }
}
