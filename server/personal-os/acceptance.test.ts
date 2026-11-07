import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { startFakeModel } from '../runtime/pi/p0/fake-model.ts';
import { assistantCompletion } from './assistant-model.ts';
import { evaluateTool } from './policy.ts';
import { createAcceptanceBridge } from '../../src/personal/acceptance-bridge.ts';
import type { AcceptanceQuote, AcceptancePrepaidQuota } from './acceptance.ts';
import { executeAcceptance, readAcceptance } from './acceptance-execution.ts';
import { searchTools } from './tool-catalog.ts';

const { createPersonalApp } = await import(process.env.NEX_TEST_BUNDLE ? pathToFileURL(path.resolve(process.env.NEX_TEST_BUNDLE)).href : './index.ts') as typeof import('./index.ts');
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nex-acceptance-test-'));
  cleanups.push(() => { expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir())); expect(path.basename(dir)).toMatch(/^nex-acceptance-test-/); rmSync(dir, { recursive: true, force: true }); });
  const fake = await startFakeModel(); cleanups.push(() => fake.close());
  const options = { dir, key: randomBytes(32), token: 'synthetic-scope', identity: false as const, hostDevice: false as const, memoryRuntime: false as const,
    modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} } };
  let app = await createPersonalApp(options);
  cleanups.push(() => app.close());
  app.store.saveConfig({ provider: 'openai', endpoint: fake.origin + '/v1', model: 'fixture-model', apiKey: 'synthetic-model-secret', contextWindow: 90000, maxOutputTokens: 8192 });
  const win = app.store.createBot('my_win'), mac = app.store.createBot('my_mac');
  app.agents.ensure(win); app.agents.ensure(mac);
  app.agents.publish(win, 'assistant', 'message', 'SYNTHETIC-OLD-CHAT-MUST-NOT-LEAK', 'old-sentinel');
  const original = () => [win, mac].map(bot => ({ bot: app.store.get('SELECT * FROM bots WHERE id=?', bot), policy: app.store.get('SELECT * FROM bot_policies WHERE bot_id=?', bot), inbox: app.store.get('SELECT * FROM agent_inboxes WHERE bot_id=?', bot), selection: app.store.botModelSelection(bot) }));
  const before = original();
  const fetchBridge: typeof fetch = async (url, init) => {
    expect(String(url)).toMatch(/^\/api\/acceptance\/(source-model|prepare|status|send|stop|attach)$/);
    expect(init?.credentials).toBe('same-origin');
    const response = await fetch(app.origin + String(url), { ...init, headers: { ...init?.headers, Cookie: 'nex=synthetic-scope' } });
    return response;
  };
  const bridge = createAcceptanceBridge(fetchBridge);
  const quote = (cost = 1): AcceptanceQuote => ({ fingerprint: app.store.acceptance.model(win).fingerprint, currency: 'CNY', unit: 'request-upper-bound', boundCnyMicros: cost, maxInputTokens: 90000, maxOutputTokens: 4096, supportsImages: false, validUntil: Date.now() + 3600000, evidence: 'SYNTHETIC-ONLY all-inclusive upper bound' });
  let index = 0;
  const prepare = async (price?: AcceptanceQuote) => {
    app.store.acceptance.options = { ...app.store.acceptance.options, quotes: price ? [price] : [] };
    const source = await bridge.sourceModel();
    return bridge.prepare({ sourceId: source.sourceId, sourceRevision: source.revision, names: Array.from({ length: 5 }, (_, n) => `fixture-${index}-${n}`), root: path.join(dir, `new-work-${index++}`) });
  };
  const payload = { model: 'fixture-model', max_tokens: 4096, messages: [{ role: 'user', content: 'synthetic' }] };
  const reserve = (bot: string, body = payload) => app.store.acceptance.reserve(bot, randomUUID(), body)!;
  const restart = async () => { await app.close(); app = await createPersonalApp(options); };
  return { get app() { return app; }, fake, dir, win, mac, before, original, bridge, quote, prepare, payload, reserve, restart };
}

it('uses only scoped projections, creates five empty conversations atomically, and refuses missing prices before input', async () => {
  const f = await fixture();
  expect(await f.bridge.sourceModel()).toMatchObject({ sourceId: f.win, model: 'fixture-model', protocol: 'openai', supplier: '127.0.0.1', connectionVersion: 1 });
  const scope = await f.prepare();
  expect(scope.ready).toBe(false);
  expect(scope.members).toHaveLength(5);
  expect(new Set(scope.members.map((member: { conversation_id: string }) => member.conversation_id)).size).toBe(5);
  expect(scope.reports).toEqual([]);
  await expect(f.bridge.send({ scopeId: scope.scopeId, botId: scope.members[0].id, clientId: randomUUID(), text: 'hello' })).rejects.toThrow('人民币');
  expect(f.app.store.all('SELECT * FROM tasks')).toHaveLength(0);
  expect(f.fake.requests).toHaveLength(0);
  expect(JSON.stringify(await f.bridge.status(scope.scopeId))).not.toContain('SYNTHETIC-OLD-CHAT');
  expect(JSON.stringify(await f.bridge.sourceModel())).not.toMatch(/synthetic-model-secret|endpoint|apiKey/);
  expect(f.original()).toEqual(f.before);
  const count = f.app.store.all('SELECT * FROM bots').length;
  await expect(f.bridge.prepare({ sourceId: f.win, sourceRevision: (await f.bridge.sourceModel()).revision, names: ['a', 'b', 'c', 'd', 'my_win'], root: path.join(f.dir, 'rollback') })).rejects.toThrow();
  expect(f.app.store.all('SELECT * FROM bots')).toHaveLength(count);
  const response = await fetch(f.app.origin + '/api/acceptance/source-model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sourceName":"my_win"}' });
  expect(response.status).toBe(401);
  const crossSite = await fetch(f.app.origin + '/api/acceptance/source-model', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'nex=synthetic-scope', 'Sec-Fetch-Site': 'cross-site' }, body: '{"sourceName":"my_win"}' });
  expect(crossSite.status).toBe(403);
});

it('atomically shares 120 attempts across all five members, counts unknowns, and never refunds duplicate or late receipts', async () => {
  const f = await fixture(), scope = await f.prepare(f.quote());
  const results = await Promise.all(Array.from({ length: 125 }, (_, i) => Promise.resolve().then(() => {
    try { return { id: f.reserve(scope.members[i % 5].id) }; } catch { return { id: null }; }
  })));
  expect(results.filter(result => result.id)).toHaveLength(120);
  const first = results[0].id!;
  f.app.store.acceptance.settle(first, false);
  f.app.store.acceptance.settle(first, true);
  const status = await f.bridge.status(scope.scopeId);
  expect(status.attempts).toBe(120);
  expect(status.heldCnyMicros).toBe(120);
  expect(status.chargedUpperCnyMicros).toBe(0);
  expect(f.fake.requests).toHaveLength(0); // Unit boundary test deliberately does not send permits.
});

it('enforces the exact 50 CNY boundary and quote/output/image/model restrictions before dispatch', async () => {
  const f = await fixture(), scope = await f.prepare(f.quote(25_000_000)), bot = scope.members[0].id;
  expect(() => f.reserve(bot, { ...f.payload, max_tokens: 4097 })).toThrow('输出');
  expect(() => f.reserve(bot, { ...f.payload, model: 'other' })).toThrow('模型');
  expect(() => f.reserve(bot, { ...f.payload, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,synthetic' } }] }] } as unknown as typeof f.payload)).toThrow('图片');
  expect((await f.bridge.status(scope.scopeId)).attempts).toBe(0);
  const key = randomUUID();
  const first = f.app.store.acceptance.reserve(bot, key, f.payload)!;
  expect(() => f.app.store.acceptance.reserve(bot, key, f.payload)).toThrow('重复');
  f.app.store.acceptance.settle(first, true);
  f.app.store.acceptance.settle(first, true);
  f.reserve(scope.members[4].id);
  expect(() => f.reserve(bot)).toThrow('预算');
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({ heldCnyMicros: 25_000_000, chargedUpperCnyMicros: 25_000_000, attempts: 2 });
  const expired = f.quote(); expired.validUntil = Date.now() - 1;
  expect((await f.prepare(expired)).ready).toBe(false);
  const invalid = f.quote(); invalid.currency = 'USD' as 'CNY';
  expect((await f.prepare(invalid)).ready).toBe(false);
  f.app.store.saveConfig({ provider: 'openai', endpoint: f.fake.origin + '/v2', model: 'fixture-model', apiKey: 'synthetic' });
  expect(() => f.reserve(bot)).toThrow('连接');
  expect(f.fake.requests).toHaveLength(0);
});

it('retains unknown reservations and stops automatic replay after a Core restart', async () => {
  const f = await fixture(), scope = await f.prepare(f.quote(100));
  const attempt = f.reserve(scope.members[0].id);
  await f.restart();
  const status = await f.bridge.status(scope.scopeId);
  expect(status).toMatchObject({ ready: false, attempts: 1, heldCnyMicros: 100, chargedUpperCnyMicros: 0 });
  expect(f.app.store.get('SELECT status FROM acceptance_attempts WHERE id=?', attempt)?.status).toBe('unknown');
  f.app.store.acceptance.settle(attempt, true);
  expect((await f.bridge.status(scope.scopeId)).heldCnyMicros).toBe(100);
  await expect(f.bridge.send({ scopeId: scope.scopeId, botId: scope.members[0].id, clientId: randomUUID(), text: 'resume' })).rejects.toThrow('停止');
  expect(f.fake.requests).toHaveLength(0);
});

it('runs five real worker/Broker workflows through the gate, caps provider output, and keeps old assistants unchanged', async () => {
  const f = await fixture(), scope = await f.prepare(f.quote(100));
  expect(scope.ready).toBe(true);
  for (const member of scope.members) {
    f.fake.scripts.push({ kind: 'openai-tool', calls: [{ id: `call-${randomUUID()}`, name: 'broker', args: JSON.stringify({ action: 'device.inventory' }) }] });
    f.fake.scripts.push({ kind: 'openai-text', text: 'scoped synthetic result' });
    const data = { scopeId: scope.scopeId, botId: member.id, clientId: randomUUID(), text: '隔离合成任务' };
    const sent = await f.bridge.send(data);
    const deadline = Date.now() + 25000;
    while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', sent.taskId)?.ended_at == null || f.app.runtime.workers.size) {
      if (Date.now() > deadline) throw new Error('Scoped fixture timed out');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status).toBe('succeeded');
    expect((await f.bridge.send(data)).taskId).toBe(sent.taskId);
  }
  expect(f.fake.requests).toHaveLength(10);
  for (const request of f.fake.requests) {
    const payload = JSON.parse(request.body);
    expect(payload.max_tokens ?? payload.max_completion_tokens).toBe(4096);
    expect(request.body).not.toContain('SYNTHETIC-OLD-CHAT');
  }
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({ attempts: 10, heldCnyMicros: 0, chargedUpperCnyMicros: 1000 });
  expect(f.original()).toEqual(f.before);
  await f.bridge.stop({ scopeId: scope.scopeId });
  await expect(f.bridge.send({ scopeId: scope.scopeId, botId: scope.members[0].id, clientId: randomUUID(), text: 'no' })).rejects.toThrow('停止');
}, 60000);

it('fails closed for auxiliary inference, external memory, unreviewed device commands and cross-scope operations', async () => {
  const f = await fixture(), one = await f.prepare(f.quote()), two = await f.prepare(f.quote()), bot = one.members[0].id;
  await expect(assistantCompletion(f.app.store, { botId: bot, purpose: 'maintain', instruction: 'fake', content: 'fake' })).rejects.toThrow('辅助');
  await expect(f.app.runtime.memory.recall(bot, 'fake')).rejects.toThrow('辅助');
  expect(f.app.runtime.memory.personal.enabled(bot)).toBe(false);
  for (const action of ['image.generate', 'device.local_agent', 'connector.call', 'memory.search', 'agent.create', 'routine.save']) expect(() => f.app.store.acceptance.assertTool(bot, { action })).toThrow();
  expect(() => evaluateTool(f.app.store, bot, { action: 'agent.delegate', botId: f.win, message: 'fake' })).toThrow();
  expect(() => evaluateTool(f.app.store, f.win, { action: 'agent.delegate', botId: bot, message: 'fake' })).toThrow();
  expect(() => f.app.store.acceptance.assertTool(bot, { action: 'device.exec', deviceId: 'fake', command: 'anything' })).toThrow();
  await expect(f.bridge.send({ scopeId: one.scopeId, botId: two.members[0].id, clientId: randomUUID(), text: 'no' })).rejects.toThrow('不属于');
  await expect(f.bridge.send({ scopeId: one.scopeId, botId: bot, clientId: randomUUID(), text: 'no', limits: { calls: 9999 } } as never)).rejects.toThrow('参数');
  const alternate = f.app.store.createConversation(bot);
  expect(() => f.app.runtime.input(alternate, 'fake', randomUUID())).toThrow('绑定');
  expect(f.fake.requests).toHaveLength(0);
  expect(f.original()).toEqual(f.before);
});

it('counts actual HTTP failures and cancellation without refunding or allowing the next over-budget physical request', async () => {
  const f = await fixture(), scope = await f.prepare(f.quote(50_000_000)), bot = scope.members[0].id;
  f.fake.scripts.push({ kind: 'openai-error', status: 500, message: 'synthetic failure' });
  const sent = await f.bridge.send({ scopeId: scope.scopeId, botId: bot, clientId: randomUUID(), text: '失败合成请求' });
  const deadline = Date.now() + 25000;
  while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', sent.taskId)?.ended_at == null || f.app.runtime.workers.size) {
    if (Date.now() > deadline) throw new Error('Failed request did not settle');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  expect(f.fake.requests).toHaveLength(1);
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({ attempts: 1, heldCnyMicros: 50_000_000, chargedUpperCnyMicros: 0, ready: false });
  expect(f.app.store.all('SELECT status FROM acceptance_attempts')).toEqual([{ status: 'unknown' }]);
  await expect(f.bridge.send({ scopeId: scope.scopeId, botId: scope.members[1].id, clientId: randomUUID(), text: 'should not send' })).rejects.toThrow('预算');

  const second = await f.prepare(f.quote(100));
  f.fake.scripts.push({ kind: 'hang' });
  const hanging = await f.bridge.send({ scopeId: second.scopeId, botId: second.members[0].id, clientId: randomUUID(), text: '取消合成请求' });
  while (f.fake.requests.length < 2) {
    if (Date.now() > deadline) throw new Error('Hanging request did not dispatch');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await expect(f.bridge.stop({ scopeId: second.scopeId, taskId: sent.taskId })).rejects.toThrow('不属于');
  await f.bridge.stop({ scopeId: second.scopeId, taskId: hanging.taskId });
  expect(await f.bridge.status(second.scopeId)).toMatchObject({ attempts: 1, heldCnyMicros: 100, chargedUpperCnyMicros: 0 });
  expect(f.app.store.get("SELECT a.status FROM acceptance_attempts a WHERE scope_id=?", second.scopeId)?.status).toBe('unknown');
}, 60000);

it('permits an exact reviewed local script through normal device authorization and approvals', async () => {
  const f = await fixture(), root = path.join(f.dir, 'new-work-0'), command = 'node reviewed-fixture.cjs';
  const paired = f.app.gateway.pair('Synthetic acceptance device');
  // Approved tools can live outside the work root. Only cwd/outputs and the
  // project argument are bound to the new workspace.
  const script = path.join(f.dir, 'reviewed-fixture.cjs');
  writeFileSync(script, "require('node:fs').writeFileSync('result.txt','synthetic local result');");
  const pinned = [process.execPath, script].map(file => ({ path: file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), ...(file === script ? { readable: true as const } : {}) }));
  f.app.store.acceptance.options.scripts = [{ root, deviceId: paired.deviceId, command, executable: process.execPath, args: [script, root], projectRootIndex: 1, risk: 'dangerous', files: pinned, networkDenied: true, credentialsExcluded: true, immutable: true }];
  f.app.store.acceptance.options.scripts.push({ ...f.app.store.acceptance.options.scripts[0], command: 'acceptance:standing-fixture', preauthorized: true });
  const scope = await f.prepare(f.quote()), bot = scope.members[0].id;
  mkdirSync(root);
  const args = { action: 'device.exec', deviceId: paired.deviceId, command, risk: 'dangerous', riskReason: 'synthetic approval lifecycle' };
  expect(() => evaluateTool(f.app.store, bot, args)).toThrow(); // Allowlist does not create device grants.
  f.app.node.configure({ origin: f.app.origin, token: paired.token, root: f.dir, exec: true, policyVersion: 1 });
  const deadline = Date.now() + 25000;
  while (!f.app.store.get('SELECT scope_json FROM device_local_grants WHERE device_id=?', paired.deviceId)) {
    if (Date.now() > deadline) throw new Error('Fixture device did not bind');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const actualGrant = String(f.app.store.get('SELECT scope_json FROM device_local_grants WHERE device_id=?', paired.deviceId)!.scope_json);
  expect(JSON.parse(actualGrant).acceptanceExec).toBe(1);
  f.app.store.run('UPDATE device_local_grants SET scope_json=? WHERE device_id=?', JSON.stringify({ exec: true }), paired.deviceId);
  expect(() => evaluateTool(f.app.store, bot, args)).toThrow('升级');
  f.app.store.run('UPDATE device_local_grants SET scope_json=? WHERE device_id=?', actualGrant, paired.deviceId);
  expect(readAcceptance(f.app.store.acceptance.reading(bot, { action: 'device.read', deviceId: paired.deviceId, path: script })!).content).toContain('synthetic local result');
  expect(() => f.app.store.acceptance.reading(bot, { action: 'device.read', deviceId: paired.deviceId, path: process.execPath })).toThrow('锁定');
  expect(evaluateTool(f.app.store, bot, args).approvalRequired).toBe(true);
  expect(() => evaluateTool(f.app.store, bot, { ...args, command: command + ' --extra' })).toThrow('已审阅');
  expect(() => evaluateTool(f.app.store, bot, { ...args, risk: 'standard' })).toThrow('已审阅');
  f.fake.scripts.push({ kind: 'openai-tool', calls: [{ id: `call-${randomUUID()}`, name: 'broker', args: JSON.stringify(args) }] });
  f.fake.scripts.push({ kind: 'openai-text', text: 'reviewed script completed' });
  const sent = await f.bridge.send({ scopeId: scope.scopeId, botId: bot, clientId: randomUUID(), text: '执行隔离本地合成脚本' });
  let approval;
  while (!(approval = f.app.store.get("SELECT a.id,a.argument_hash FROM approvals a JOIN tool_calls c ON c.id=a.tool_call_id WHERE c.task_id=? AND a.status='pending'", sent.taskId))) {
    if (Date.now() > deadline) throw new Error('Device approval not requested');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  expect(f.app.node.journal.prepare('SELECT COUNT(*) n FROM node_calls').get()).toEqual({ n: 0 });
  f.app.runtime.decide(String(approval.id), String(approval.argument_hash), true);
  while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', sent.taskId)?.ended_at == null || f.app.runtime.workers.size) {
    if (Date.now() > deadline) throw new Error('Reviewed script did not finish');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  expect(f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status).toBe('succeeded');
  expect(f.app.node.journal.prepare("SELECT COUNT(*) n FROM node_calls WHERE capability='device.exec' AND status='succeeded'").get()).toEqual({ n: 1 });
  expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('synthetic local result');
  const standingArgs = { ...args, command: 'acceptance:standing-fixture' };
  expect(evaluateTool(f.app.store, bot, standingArgs).approvalRequired).toBe(false);
  f.fake.scripts.push({ kind: 'openai-tool', calls: [{ id: `call-${randomUUID()}`, name: 'broker', args: JSON.stringify(standingArgs) }] });
  f.fake.scripts.push({ kind: 'openai-text', text: 'standing script completed' });
  const automatic = await f.bridge.send({ scopeId: scope.scopeId, botId: bot, clientId: randomUUID(), text: '执行已预授权的精确本地脚本' });
  while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', automatic.taskId)?.ended_at == null || f.app.runtime.workers.size) {
    if (Date.now() > deadline) throw new Error('Standing authorization did not finish');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  expect(f.app.store.get('SELECT status FROM tasks WHERE id=?', automatic.taskId)?.status).toBe('succeeded');
  expect(f.app.store.all('SELECT a.id FROM approvals a JOIN tool_calls c ON c.id=a.tool_call_id WHERE c.task_id=?', automatic.taskId)).toHaveLength(0);
  expect(f.app.node.journal.prepare("SELECT COUNT(*) n FROM node_calls WHERE capability='device.exec' AND status='succeeded'").get()).toEqual({ n: 2 });
  expect(() => executeAcceptance({ ...f.app.store.acceptance.execution(bot, args)!, runtimeExecutables: [path.join(f.dir, 'unlisted.exe')] }, 5000)).toThrow('运行时');
  expect(() => executeAcceptance({ ...f.app.store.acceptance.execution(bot, args)!, userDirectories: { MODEL_API_KEY: 'synthetic-not-a-directory' } as never }, 5000)).toThrow('非秘密');
  writeFileSync(script, "throw new Error('modified script must not run');");
  expect(() => executeAcceptance(f.app.store.acceptance.execution(bot, args)!, 5000)).toThrow('哈希');
  expect(() => readAcceptance(f.app.store.acceptance.reading(bot, { action: 'device.read', deviceId: paired.deviceId, path: script })!)).toThrow('哈希');
  expect(f.original()).toEqual(f.before);
}, 60000);

it('delegates within the five-member scope using the original identity and shared model budget', async () => {
  const f = await fixture(), scope = await f.prepare(f.quote(100)), [parent, child] = scope.members;
  f.fake.scripts.push({ kind: 'openai-tool', calls: [{ id: `call-${randomUUID()}`, name: 'broker', args: JSON.stringify({ action: 'agent.directory' }) }] });
  f.fake.scripts.push({ kind: 'openai-tool', calls: [{ id: `call-${randomUUID()}`, name: 'broker', args: JSON.stringify({ action: 'agent.delegate', botId: child.id, message: '合成子任务，仅返回结果' }) }] });
  f.fake.scripts.push({ kind: 'openai-text', text: 'scoped child result' });
  f.fake.scripts.push({ kind: 'openai-text', text: 'scoped parent report' });
  const sent = await f.bridge.send({ scopeId: scope.scopeId, botId: parent.id, clientId: randomUUID(), text: '向本范围内同伴派活' });
  const deadline = Date.now() + 25000;
  while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', sent.taskId)?.ended_at == null || f.app.runtime.workers.size) {
    if (Date.now() > deadline) throw new Error('Delegation did not finish');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const directoryCall = f.app.store.get("SELECT result_json FROM tool_calls WHERE task_id=? AND tool_name='agent.directory'", sent.taskId)!;
  const peers = JSON.parse(String(directoryCall.result_json)).agents;
  expect(peers).toHaveLength(4);
  expect(peers.every((peer: { id: string }) => scope.members.some(member => member.id === peer.id))).toBe(true);
  const link = f.app.store.get('SELECT * FROM a2a_messages WHERE parent_task_id=?', sent.taskId)!;
  expect(link.status).toBe('succeeded');
  expect(f.app.store.get('SELECT authorized_session_id,status FROM tasks WHERE id=?', link.child_task_id)).toEqual({ authorized_session_id: f.app.store.session, status: 'succeeded' });
  expect(f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status).toBe('succeeded');
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({ attempts: 4, chargedUpperCnyMicros: 400 });
  expect(f.fake.requests).toHaveLength(4);
  expect(f.original()).toEqual(f.before);
}, 60000);

it('waits beyond the ordinary device timeout using a bounded trusted manifest without model polling', async () => {
  const f = await fixture(), root = path.join(f.dir, 'new-work-0'), paired = f.app.gateway.pair('Synthetic long job device');
  const script = path.join(f.dir, 'long-fixture.cjs');
  writeFileSync(script, "const fs=require('node:fs'),start=Date.now();setTimeout(()=>fs.writeFileSync('long-result.txt',String(Date.now()-start)),32000);");
  f.app.store.acceptance.options.scripts = [{ root, deviceId: paired.deviceId, command: 'acceptance:bounded-wait', executable: process.execPath, args: [script, root], projectRootIndex: 1,
    timeoutMs: 45000, risk: 'standard', networkDenied: true, credentialsExcluded: true, immutable: true,
    files: [process.execPath, script].map(file => ({ path: file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })) }];
  const scope = await f.prepare(f.quote()); mkdirSync(root);
  f.app.node.configure({ origin: f.app.origin, token: paired.token, root: f.dir, exec: true, policyVersion: 1 });
  const deadline = Date.now() + 55000;
  while (!f.app.store.get('SELECT scope_json FROM device_local_grants WHERE device_id=?', paired.deviceId)) {
    if (Date.now() > deadline) throw new Error('Long fixture did not bind');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  f.fake.scripts.push({ kind: 'openai-tool', calls: [{ id: `call-${randomUUID()}`, name: 'broker', args: JSON.stringify({ action: 'device.exec', deviceId: paired.deviceId, command: 'acceptance:bounded-wait', risk: 'standard' }) }] });
  f.fake.scripts.push({ kind: 'openai-text', text: 'bounded local wait finished' });
  const sent = await f.bridge.send({ scopeId: scope.scopeId, botId: scope.members[0].id, clientId: randomUUID(), text: '等待受控离线作业结束，不轮询模型' });
  let observedWait = false;
  while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', sent.taskId)?.ended_at == null || f.app.runtime.workers.size) {
    if (Date.now() > deadline) throw new Error('Long fixture did not finish');
    const call = f.app.store.get("SELECT c.status,d.lease_expires_at,d.lease_issued_at,d.deadline_at,d.created_at FROM tool_calls c JOIN device_calls d ON d.id=c.id WHERE c.task_id=?", sent.taskId);
    if (call?.status === 'executing') { observedWait = true; expect(f.fake.requests).toHaveLength(1); expect(Number(call.deadline_at) - Number(call.created_at)).toBeGreaterThanOrEqual(45000); expect(Number(call.lease_expires_at) - Number(call.lease_issued_at)).toBeLessThanOrEqual(30000); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  expect(observedWait, JSON.stringify(f.app.store.all('SELECT tool_name,status,result_json FROM tool_calls WHERE task_id=?', sent.taskId))).toBe(true);
  expect(Number(readFileSync(path.join(root, 'long-result.txt'), 'utf8'))).toBeGreaterThanOrEqual(31000);
  expect(f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status).toBe('succeeded');
  expect(f.fake.requests).toHaveLength(2);
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({ attempts: 2 });
}, 60000);

it('pins the resolved default model and connection revision rather than following later defaults', async () => {
  const f = await fixture(), originalSource = await f.bridge.sourceModel(), scope = await f.prepare(f.quote());
  for (const member of scope.members) expect(f.app.store.botModelSelection(member.id)?.selected_model).toBe('fixture-model');
  f.app.store.saveConfig({ provider: 'openai', endpoint: f.fake.origin + '/v1', model: 'new-default', apiKey: 'synthetic-only', contextWindow: 90000, maxOutputTokens: 8192 });
  await expect(f.bridge.prepare({ sourceId: f.win, sourceRevision: originalSource.revision, names: ['stale1','stale2','stale3','stale4','stale5'], root: path.join(f.dir, 'stale') })).rejects.toThrow('版本');
  expect((await f.bridge.status(scope.scopeId)).ready).toBe(false);
  expect((await f.bridge.status(scope.scopeId)).model.id).toBe('fixture-model');
  await expect(f.bridge.send({ scopeId: scope.scopeId, botId: scope.members[0].id, clientId: randomUUID(), text: 'no drift' })).rejects.toThrow('连接');
  expect(f.fake.requests).toHaveLength(0);
});

it('projects report task identity from the database so another task cannot be claimed by proposal text', async () => {
  const f = await fixture(), scope = await f.prepare(f.quote()), bot = scope.members[0].id;
  const sent = [];
  for (const claimed of ['forged-other-task', 'another-forged-task']) {
    f.fake.scripts.push({ kind: 'openai-text', text: JSON.stringify({ task_id: claimed, proposal: 'synthetic data' }) });
    const task = await f.bridge.send({ scopeId: scope.scopeId, botId: bot, clientId: randomUUID(), text: claimed });
    sent.push(task.taskId);
    const deadline = Date.now() + 25000;
    while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', task.taskId)?.ended_at == null || f.app.runtime.workers.size) { if (Date.now() > deadline) throw new Error('Report task did not finish'); await new Promise(resolve => setTimeout(resolve, 30)); }
  }
  const status = await f.bridge.status(scope.scopeId);
  const reports = status.reports.filter(report => report.role === 'assistant' && report.content.includes('synthetic data'));
  expect(reports).toHaveLength(2);
  expect(new Set(reports.map(report => report.task_id))).toEqual(new Set(sent));
  for (const report of reports) {
    const task = status.tasks.find(task => task.id === report.task_id)!;
    expect(task.status).toBe('succeeded'); expect(task.bot_id).toBe(bot);
    expect(JSON.parse(report.content).task_id).not.toBe(report.task_id);
    expect(report.task_id).not.toBe(sent.find(id => id !== report.task_id));
  }
}, 60000);

it('lets only one of five concurrent worker requests consume the last monetary reservation', async () => {
  const f = await fixture(), scope = await f.prepare(f.quote(50_000_000));
  f.fake.scripts.push({ kind: 'hang' });
  await Promise.allSettled(scope.members.map(member => f.bridge.send({ scopeId: scope.scopeId, botId: member.id, clientId: randomUUID(), text: '合成并发请求' })));
  const deadline = Date.now() + 25000;
  while (f.fake.requests.length < 1) {
    if (Date.now() > deadline) throw new Error('Concurrent requests did not dispatch');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await f.bridge.stop({ scopeId: scope.scopeId });
  expect(f.fake.requests).toHaveLength(1);
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({ attempts: 1, heldCnyMicros: 50_000_000, ready: false });
}, 60000);

it('prices image understanding in the same scope and refuses image uploads without an inclusive quote', async () => {
  const f = await fixture(), unpricedImage = await f.prepare(f.quote());
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await expect(f.bridge.attach({ scopeId: unpricedImage.scopeId, botId: unpricedImage.members[0].id, name: 'synthetic.png', data: png })).rejects.toThrow('图片');
  expect(f.app.store.all('SELECT * FROM chat_attachments')).toHaveLength(0);
  const quote = f.quote(100); quote.supportsImages = true;
  const scope = await f.prepare(quote), bot = scope.members[0].id;
  const file = await f.bridge.attach({ scopeId: scope.scopeId, botId: bot, name: 'synthetic.png', data: png });
  await expect(f.bridge.send({ scopeId: scope.scopeId, botId: scope.members[1].id, clientId: randomUUID(), text: 'cross-file', attachments: [file.id] })).rejects.toThrow('附件');
  f.fake.scripts.push({ kind: 'openai-tool', calls: [{ id: `call-${randomUUID()}`, name: 'broker', args: JSON.stringify({ action: 'attachment.read', attachmentId: file.id }) }] });
  f.fake.scripts.push({ kind: 'openai-text', text: 'synthetic image understood' });
  const sent = await f.bridge.send({ scopeId: scope.scopeId, botId: bot, clientId: randomUUID(), text: '查看合成图片', attachments: [file.id] });
  const deadline = Date.now() + 25000;
  while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', sent.taskId)?.ended_at == null || f.app.runtime.workers.size) {
    if (Date.now() > deadline) throw new Error('Image understanding did not settle');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  expect(f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status).toBe('succeeded');
  expect(f.fake.requests).toHaveLength(2);
  expect(f.fake.requests[1].body).toContain('data:image/png;base64,');
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({ attempts: 2, chargedUpperCnyMicros: 200, heldCnyMicros: 0 });
}, 60000);

const runtimePaths = ['NEX_ACCEPTANCE_PYTHON', 'NEX_ACCEPTANCE_FFMPEG', 'NEX_ACCEPTANCE_FFPROBE'].map(key => process.env[key]);
it('reads both pages of a >24k pinned UTF-8 document over DCP and rechecks its hash on every page', async () => {
  const f = await fixture(), root = path.join(f.dir, 'new-work-0'), paired = f.app.gateway.pair('Synthetic paged reader');
  const document = path.join(f.dir, 'long-manual.txt'), content = 'HEAD-MARKER\n' + '合成规范资料。'.repeat(5000) + '\nTAIL-MARKER';
  writeFileSync(document, content);
  const pinned = { path: document, sha256: createHash('sha256').update(readFileSync(document)).digest('hex'), readable: true as const };
  f.app.store.acceptance.options.scripts = [{ root, deviceId: paired.deviceId, command: 'acceptance:manual-only', executable: process.execPath, args: [root], projectRootIndex: 0, risk: 'standard', files: [pinned], networkDenied: true, credentialsExcluded: true, immutable: true }];
  const scope = await f.prepare(f.quote()), bot = scope.members[0].id;
  const firstArgs = { action: 'device.read', deviceId: paired.deviceId, path: document, offset: 0, limit: 24000 };
  expect(() => f.app.store.acceptance.reading(bot, { ...firstArgs, offset: 0.5 })).toThrow('分页');
  expect(() => f.app.store.acceptance.reading(bot, { ...firstArgs, limit: 24001 })).toThrow('分页');
  const catalog = searchTools(f.app.store, bot, { query: 'device.read' });
  const properties = catalog.items[0].parameters!.properties as Record<string, unknown>;
  expect(properties.limit).toMatchObject({ maximum: 24000 });
  expect(properties.offset).toMatchObject({ minimum: 0 });
  f.app.node.configure({ origin: f.app.origin, token: paired.token, root: f.dir, exec: true, policyVersion: 1 });
  const deadline = Date.now() + 25000;
  while (!f.app.store.get('SELECT scope_json FROM device_local_grants WHERE device_id=?', paired.deviceId)) { if (Date.now() > deadline) throw new Error('Reader did not bind'); await new Promise(resolve => setTimeout(resolve, 30)); }
  for (const offset of [0, 24000]) f.fake.scripts.push({ kind: 'openai-tool', calls: [{ id: `call-${randomUUID()}`, name: 'broker', args: JSON.stringify({ ...firstArgs, offset }) }] });
  f.fake.scripts.push({ kind: 'openai-text', text: 'both pages read' });
  const sent = await f.bridge.send({ scopeId: scope.scopeId, botId: bot, clientId: randomUUID(), text: '完整读取合成规范首尾两页' });
  while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', sent.taskId)?.ended_at == null || f.app.runtime.workers.size) { if (Date.now() > deadline) throw new Error('Paged read did not finish'); await new Promise(resolve => setTimeout(resolve, 30)); }
  const pages = f.app.store.all("SELECT result_json FROM tool_calls WHERE task_id=? AND tool_name='device.read' ORDER BY created_at", sent.taskId).map(row => JSON.parse(String(row.result_json)));
  expect(pages).toHaveLength(2);
  expect(pages[0]).toMatchObject({ offset: 0, nextOffset: 24000, truncated: true });
  expect(pages[1]).toMatchObject({ offset: 24000, nextOffset: null, truncated: false });
  expect(pages[0].content + pages[1].content).toBe(content);
  expect(pages[1].content).toContain('TAIL-MARKER');
  writeFileSync(document, content + 'changed');
  expect(() => readAcceptance(f.app.store.acceptance.reading(bot, { ...firstArgs, offset: 24000 })!)).toThrow('哈希');
  expect(f.fake.requests).toHaveLength(3);
}, 60000);

it.skipIf(runtimePaths.some(file => !file))('executes pinned local Python/FFmpeg/ffprobe over DCP without inheriting credential variables', async () => {
  const f = await fixture(), [python, ffmpeg, ffprobe] = runtimePaths as string[];
  const root = path.join(f.dir, 'new-work-0'), paired = f.app.gateway.pair('Synthetic runtime device');
  const script = path.join(f.dir, 'runtime-fixture.py'), report = path.join(root, 'runtime-report.json');
  writeFileSync(script, [
    'import json, os, pathlib, shutil, subprocess, sys',
    'project, ffmpeg, ffprobe = sys.argv[1:]',
    'assert pathlib.Path.cwd().resolve() == pathlib.Path(project).resolve()',
    'assert not any(k in os.environ for k in ("NEXORAI_API_KEY", "H3_API_KEY", "MODEL_API_KEY", "PYTHONPATH", "NODE_OPTIONS"))',
    'assert pathlib.Path(shutil.which("ffmpeg")).resolve() == pathlib.Path(ffmpeg).resolve()',
    'assert pathlib.Path(shutil.which("ffprobe")).resolve() == pathlib.Path(ffprobe).resolve()',
    'assert os.environ["USERPROFILE"] == project and os.environ["LOCALAPPDATA"] == project',
    'subprocess.run([ffmpeg,"-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=black:s=16x16:r=5","-t","0.2","-c:v","mpeg4","synthetic.mp4"], check=True, timeout=8)',
    'result=subprocess.run([ffprobe,"-v","error","-show_entries","format=duration","-of","json","synthetic.mp4"], check=True, capture_output=True, text=True, timeout=8)',
    'versions=[subprocess.run([tool,"-version"],check=True,capture_output=True,text=True,timeout=5).stdout.splitlines()[0] for tool in (ffmpeg,ffprobe)]',
    'pathlib.Path("runtime-report.json").write_text(json.dumps({"credentialVariablesAbsent":True,"python":sys.version.split()[0],"ffmpeg":versions[0],"ffprobe":versions[1],"duration":json.loads(result.stdout)["format"]["duration"],"fixedRuntimePaths":True}), encoding="utf8")',
  ].join('\n'));
  const files = [python, ffmpeg, ffprobe, script].map(file => ({ path: file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }));
  f.app.store.acceptance.options.scripts = [{ root, deviceId: paired.deviceId, command: 'acceptance:offline-runtime-check', executable: python, args: [script, root, ffmpeg, ffprobe], projectRootIndex: 1,
    runtimeExecutables: [python, ffmpeg, ffprobe], userDirectories: { USERPROFILE: root, LOCALAPPDATA: root }, files, risk: 'standard', networkDenied: true, credentialsExcluded: true, immutable: true }];
  const scope = await f.prepare(f.quote());
  mkdirSync(root);
  // Set only synthetic sentinels inside this isolated Vitest worker. Never read
  // or copy any inherited real key value; this worker is discarded afterwards.
  process.env.NEXORAI_API_KEY = 'synthetic-must-not-inherit';
  process.env.H3_API_KEY = 'synthetic-must-not-inherit';
  process.env.MODEL_API_KEY = 'synthetic-must-not-inherit';
  process.env.PYTHONPATH = 'synthetic-must-not-inherit';
  try {
    f.app.node.configure({ origin: f.app.origin, token: paired.token, root: f.dir, exec: true, policyVersion: 1 });
    const deadline = Date.now() + 25000;
    while (!f.app.store.get('SELECT scope_json FROM device_local_grants WHERE device_id=?', paired.deviceId)) {
      if (Date.now() > deadline) throw new Error('Runtime fixture did not bind');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    f.fake.scripts.push({ kind: 'openai-tool', calls: [{ id: `call-${randomUUID()}`, name: 'broker', args: JSON.stringify({ action: 'device.exec', deviceId: paired.deviceId, command: 'acceptance:offline-runtime-check', risk: 'standard' }) }] });
    f.fake.scripts.push({ kind: 'openai-text', text: 'offline runtime verified' });
    const sent = await f.bridge.send({ scopeId: scope.scopeId, botId: scope.members[0].id, clientId: randomUUID(), text: '验证离线运行时，不调用任何真实推理服务' });
    while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', sent.taskId)?.ended_at == null || f.app.runtime.workers.size) {
      if (Date.now() > deadline) throw new Error('Runtime fixture did not finish');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(f.app.store.get('SELECT status FROM tasks WHERE id=?', sent.taskId)?.status).toBe('succeeded');
    const runtimeReport = JSON.parse(readFileSync(report, 'utf8'));
    expect(runtimeReport).toMatchObject({ credentialVariablesAbsent: true, fixedRuntimePaths: true, duration: '0.200000' });
    console.log(JSON.stringify({ acceptanceRuntime: { files: files.slice(0, 3), ...runtimeReport, realModelRequests: 0 } }));
    expect(f.app.node.journal.prepare("SELECT COUNT(*) n FROM node_calls WHERE status='succeeded'").get()).toEqual({ n: 1 });
    expect(f.fake.requests).toHaveLength(2);
  } finally {
    for (const key of ['NEXORAI_API_KEY', 'H3_API_KEY', 'MODEL_API_KEY', 'PYTHONPATH']) delete process.env[key];
  }
}, 60000);

function prepaid(f: Awaited<ReturnType<typeof fixture>>, index = 0): AcceptancePrepaidQuota {
  return { mode: 'prepaid-quota', root: path.join(f.dir, `new-work-${index}`), fingerprint: f.app.store.acceptance.model(f.win).fingerprint,
    authorization: { approved: true, evidence: 'SYNTHETIC explicit approval for this root: 120 physical requests, no recharge, no CNY conversion' },
    calls: 120, maxOutputTokens: 4096, maxInputTokens: 90000, supportsImages: true, validUntil: Date.now() + 3600000 };
}
async function finished(f: Awaited<ReturnType<typeof fixture>>, taskId: string) {
  const end = Date.now() + 25000;
  while (f.app.store.get('SELECT ended_at FROM tasks WHERE id=?', taskId)?.ended_at == null || f.app.runtime.workers.size) {
    if (Date.now() > end) throw new Error('Prepaid fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
it('requires trusted exact-root/fingerprint explicit prepaid authorization and rejects HTTP budget overrides', async () => {
  const f = await fixture();
  const mutations: Array<(p: AcceptancePrepaidQuota) => void> = [p => p.root += '-other', p => p.fingerprint = 'stale', p => p.authorization.evidence = '', p => p.authorization.approved = false as true, p => p.calls = 121 as 120, p => p.maxOutputTokens = 4097 as 4096, p => p.validUntil = 1, p => p.maxInputTokens = 100];
  for (const [index, mutate] of mutations.entries()) {
    const policy = prepaid(f, index); mutate(policy); f.app.store.acceptance.options.prepaidQuotas = [policy];
    expect((await f.prepare()).ready).toBe(false);
  }
  const source = await f.bridge.sourceModel();
  await expect(f.bridge.prepare({ sourceId: source.sourceId, sourceRevision: source.revision, names: ['x1','x2','x3','x4','x5'], root: path.join(f.dir,'http-override'), budgetMode: 'prepaid-quota', calls: 120 } as never)).rejects.toThrow('参数');
  expect(f.app.store.all('SELECT * FROM acceptance_prepaid_scopes')).toHaveLength(0);
  expect(f.fake.requests).toHaveLength(0);
  expect(f.original()).toEqual(f.before);
});
it('shares exactly 120 prepaid permits concurrently, includes image requests and unknowns, and projects no CNY amounts', async () => {
  const f = await fixture(); f.app.store.acceptance.options.prepaidQuotas = [prepaid(f)];
  const scope = await f.prepare(); expect(scope.ready).toBe(true);
  expect(f.app.store.get('SELECT quote_json FROM acceptance_scopes WHERE id=?',scope.scopeId)?.quote_json).toBeNull();
  const results = await Promise.all(Array.from({length: 125}, (_, i) => Promise.resolve().then(() => {
    try { return f.reserve(scope.members[i % 5].id, { ...f.payload, messages: [{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,synthetic'}}]}] } as never); } catch { return null; }
  })));
  expect(results.filter(Boolean)).toHaveLength(120);
  f.app.store.acceptance.settle(results[0]!, false); f.app.store.acceptance.settle(results[0]!, true);
  f.app.store.acceptance.settle(results[1]!, true); f.app.store.acceptance.settle(results[1]!, true);
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({budgetMode:'prepaid-quota',attempts:120,heldCnyMicros:null,chargedUpperCnyMicros:null,limits:{calls:120,maxOutput:4096,cnyMicros:null},ready:false});
  expect(f.app.store.all('SELECT status FROM acceptance_attempts WHERE scope_id=?',scope.scopeId).filter(a=>a.status==='unknown')).toHaveLength(1);
  expect(() => f.reserve(scope.members[0].id)).toThrow('预算');
  expect(f.fake.requests).toHaveLength(0);
});
it('persists prepaid authorization/counts across restart, locks source connection, and never replays unknown permits', async () => {
  const f = await fixture(); f.app.store.acceptance.options.prepaidQuotas = [prepaid(f)];
  const scope = await f.prepare(), bot=scope.members[0].id;
  const first=f.reserve(bot); f.app.store.acceptance.settle(first,true);
  await f.restart();
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({ready:true,budgetMode:'prepaid-quota',attempts:1,chargedUpperCnyMicros:null});
  const pending=f.reserve(bot); await f.restart();
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({ready:false,attempts:2,heldCnyMicros:null});
  expect(f.app.store.get('SELECT status FROM acceptance_attempts WHERE id=?',pending)?.status).toBe('unknown');
  expect(() => f.reserve(bot)).toThrow('停止');
  const p=prepaid(f,1); f.app.store.acceptance.options.prepaidQuotas=[p]; const two=await f.prepare();
  f.app.store.saveConfig({provider:'openai',endpoint:f.fake.origin+'/v2',model:'fixture-model',apiKey:'synthetic'});
  expect(() => f.reserve(two.members[0].id)).toThrow('连接');
  expect(f.fake.requests).toHaveLength(0);
});
it('runs all five prepaid workers with image understanding on one ledger, blocks auxiliaries, and preserves old bots', async () => {
  const f=await fixture(); f.app.store.acceptance.options.prepaidQuotas=[prepaid(f)]; const scope=await f.prepare();
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  for (const [i,member] of scope.members.entries()) {
    const file=await f.bridge.attach({scopeId:scope.scopeId,botId:member.id,name:'synthetic.png',data:png});
    f.fake.scripts.push({kind:'openai-tool',calls:[{id:randomUUID(),name:'broker',args:JSON.stringify({action:'attachment.read',attachmentId:file.id})}]});
    f.fake.scripts.push({kind:'openai-text',text:'套餐合成结果✅'});
    const sent=await f.bridge.send({scopeId:scope.scopeId,botId:member.id,clientId:randomUUID(),text:'查看合成图',attachments:[file.id]}); await finished(f,sent.taskId);
    expect(f.app.store.get('SELECT status FROM tasks WHERE id=?',sent.taskId)?.status).toBe('succeeded');
    expect((await f.bridge.status(scope.scopeId)).attempts).toBe((i+1)*2);
  }
  await expect(assistantCompletion(f.app.store,{botId:scope.members[0].id,purpose:'maintain',instruction:'fake',content:'fake'})).rejects.toThrow('辅助');
  await expect(f.app.runtime.memory.recall(scope.members[0].id,'fake')).rejects.toThrow('辅助');
  expect(() => evaluateTool(f.app.store,scope.members[0].id,{action:'agent.delegate',botId:f.win,message:'fake'})).toThrow();
  expect(f.fake.requests).toHaveLength(10); expect(f.fake.requests.filter(r=>r.body.includes('data:image/png;base64,'))).toHaveLength(5);
  expect(f.fake.requests.every(r=>(JSON.parse(r.body).max_tokens??JSON.parse(r.body).max_completion_tokens)<=4096)).toBe(true);
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({attempts:10,chargedUpperCnyMicros:null,heldCnyMicros:null}); expect(f.original()).toEqual(f.before);
},60000);
it.each([402,429,400,200])('freezes the entire prepaid scope after HTTP/business quota exhaustion (%s), with no peer retry', async status => {
  const f=await fixture(); f.app.store.acceptance.options.prepaidQuotas=[prepaid(f)]; const scope=await f.prepare();
  f.fake.scripts.push({kind:'openai-error',status,message:'insufficient_quota: SYNTHETIC quota exhausted'});
  const sent=await f.bridge.send({scopeId:scope.scopeId,botId:scope.members[0].id,clientId:randomUUID(),text:'合成配额错误'}); await finished(f,sent.taskId);
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({attempts:1,ready:false,budgetMode:'prepaid-quota',quotaError:'套餐配额不足或被限流，已停止新增请求',chargedUpperCnyMicros:null});
  expect(f.fake.requests).toHaveLength(1);
  await expect(f.bridge.send({scopeId:scope.scopeId,botId:scope.members[4].id,clientId:randomUUID(),text:'禁止重试'})).rejects.toThrow('停止');
  await f.restart(); expect((await f.bridge.status(scope.scopeId)).ready).toBe(false); expect(f.fake.requests).toHaveLength(1);
},60000);
it('counts prepaid network failures and cancellation without returning permits or declaring zero CNY', async () => {
  const f=await fixture(); f.app.store.acceptance.options.prepaidQuotas=[prepaid(f)]; const scope=await f.prepare();
  f.fake.scripts.push({kind:'openai-error',status:500,message:'synthetic unavailable'});
  const sent=await f.bridge.send({scopeId:scope.scopeId,botId:scope.members[0].id,clientId:randomUUID(),text:'合成失败'}); await finished(f,sent.taskId);
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({attempts:1,ready:true,chargedUpperCnyMicros:null});
  f.fake.scripts.push({kind:'hang'}); const second=await f.bridge.send({scopeId:scope.scopeId,botId:scope.members[1].id,clientId:randomUUID(),text:'合成取消'});
  const end=Date.now()+25000; while(f.fake.requests.length<2){if(Date.now()>end)throw new Error('No dispatch');await new Promise(r=>setTimeout(r,30));}
  await f.bridge.stop({scopeId:scope.scopeId,taskId:second.taskId});
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({attempts:2,heldCnyMicros:null,chargedUpperCnyMicros:null});
  expect(f.app.store.all('SELECT status FROM acceptance_attempts WHERE scope_id=?',scope.scopeId)).toEqual([{status:'unknown'},{status:'unknown'}]);
},60000);

it('restricts a standing scope script to trusted real bot names while leaving pinned reads shared', async () => {
  const f=await fixture(), root=path.join(f.dir,'new-work-0'), script=path.join(f.dir,'role.cjs'); writeFileSync(script,'// synthetic shared manual');
  const policy={root,deviceId:'fixture-device',command:'acceptance:director',executable:process.execPath,args:[script,root],projectRootIndex:1,risk:'standard' as const,preauthorized:true as const,allowedBotNames:['fixture-0-0'],networkDenied:true,credentialsExcluded:true as const,immutable:true as const,files:[process.execPath,script].map(file=>({path:file,sha256:createHash('sha256').update(readFileSync(file)).digest('hex'),...(file===script?{readable:true as const}:{})}))};
  f.app.store.acceptance.options.scripts=[policy]; const scope=await f.prepare(f.quote());
  const args={action:'device.exec',deviceId:policy.deviceId,command:policy.command,risk:'standard'};
  expect(f.app.store.acceptance.preauthorized(scope.members[0].id,args)).toBe(true);
  expect(()=>f.app.store.acceptance.execution(scope.members[1].id,{...args,botName:'fixture-0-0'})).toThrow('岗位');
  expect(()=>f.app.store.acceptance.preauthorized(scope.members[1].id,args)).toThrow('岗位');
  expect(f.app.store.acceptance.reading(scope.members[1].id,{action:'device.read',deviceId:policy.deviceId,path:script})).toMatchObject({path:script});
});

it('adds prepaid storage to an existing schema-43 CNY workspace without changing its accounting', async () => {
  const f=await fixture(), scope=await f.prepare(f.quote(100)); const permit=f.reserve(scope.members[0].id); f.app.store.acceptance.settle(permit,true);
  f.app.store.run('DROP TABLE acceptance_prepaid_scopes'); f.app.store.run('DELETE FROM schema_migrations WHERE version=44');
  await f.restart();
  expect(await f.bridge.status(scope.scopeId)).toMatchObject({ready:true,budgetMode:'cny-upper-bound',attempts:1,chargedUpperCnyMicros:100,heldCnyMicros:0,limits:{cnyMicros:50000000}});
  expect(f.app.store.get('SELECT version FROM schema_migrations WHERE version=44')?.version).toBe(44);
  expect(f.original()).toEqual(f.before); expect(f.fake.requests).toHaveLength(0);
});

it('projects source context and only the requested owned device without any credentials or legacy history', async () => {
  const f=await fixture(); const device=f.app.gateway.pair('Synthetic Windows');
  const data={sourceName:'my_win',deviceId:device.deviceId};
  const response=await fetch(f.app.origin+'/api/acceptance/source-model',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'nex=synthetic-scope'},body:JSON.stringify(data)});
  expect(response.status).toBe(200); const meta=await response.json();
  expect(meta).toMatchObject({workspaceId:f.app.store.workspace,contextWindow:90000,device:{id:device.deviceId,name:'Synthetic Windows',acceptanceExec:false}});
  expect(JSON.stringify(meta)).not.toMatch(/synthetic-model-secret|SYNTHETIC-OLD-CHAT|credential|token|endpoint/);
  expect(f.app.store.acceptance.sourceModel('my_win','not-owned').device).toBeNull();
  f.app.store.insert('users',{id:'other-user',display_name:'Synthetic other',status:'active',created_at:Date.now()});
  f.app.store.insert('memberships',{workspace_id:f.app.store.workspace,user_id:'other-user',status:'active',created_at:Date.now()});
  f.app.store.run('UPDATE devices SET owner_user_id=? WHERE id=?','other-user',device.deviceId);
  expect(f.app.store.acceptance.sourceModel('my_win',device.deviceId).device).toBeNull();
  expect(f.fake.requests).toHaveLength(0);
});
