import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { startAcceptancePipe, validateAcceptanceCommand, forwardAcceptance, acceptanceDto } from './nex-acceptance-bridge.mjs';

test('accepts only fixed business commands and projects primitive DTO fields', async () => {
  assert.throws(() => validateAcceptanceCommand({ command: 'eval', args: 'process.env' }));
  assert.throws(() => validateAcceptanceCommand({ command: 'sourceModel', args: {} }));
  assert.deepEqual(acceptanceDto('sourceModel', { sourceId: 's', model: 'fixture', cookie: 'synthetic-secret', supplier: { apiKey: 'synthetic-secret' } }), { sourceId: 's', model: 'fixture' });
  assert.deepEqual(acceptanceDto('sourceModel', { workspaceId: 'w', contextWindow: 90000, device: { id: 'd', hostname: '合成电脑', acceptanceExec: true, token: 'synthetic-secret', scope_json: 'private' } }), { workspaceId: 'w', contextWindow: 90000, device: { id: 'd', hostname: '合成电脑', acceptanceExec: true } });
  assert.equal(acceptanceDto('status', { reports: [{ id: 'report', bot_id: 'bot', task_id: 'database-task', content: '{"task_id":"forged"}' }] }).reports[0].task_id, 'database-task');
  const quota = acceptanceDto('status', { budgetMode: 'prepaid-quota', heldCnyMicros: null, chargedUpperCnyMicros: null, quotaError: null, limits: { calls: 120, cnyMicros: null, maxOutput: 4096 }, authorization: { evidence: 'operator-private' } });
  assert.equal(quota.budgetMode, 'prepaid-quota'); assert.equal(quota.heldCnyMicros, null); assert.equal(quota.chargedUpperCnyMicros, null); assert.equal(quota.limits.cnyMicros, null); assert.ok(!('authorization' in quota));
  const window = { isDestroyed: () => false, webContents: { mainFrame: {}, getURL: () => 'https://fixture.example/', executeJavaScript: async code => { assert.match(code, /^globalThis\.nexAcceptance\["sourceModel"\]\(\)$/); return { sourceId: 's', model: 'fixture', apiKey: 'synthetic-secret' }; } } };
  assert.deepEqual(await forwardAcceptance(window, 'https://fixture.example', { command: 'sourceModel' }), { sourceId: 's', model: 'fixture' });
  await assert.rejects(forwardAcceptance(window, 'https://other.example', { command: 'sourceModel' }));
});

test('uses a current-user ACL Windows pipe and an actual external PowerShell client', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'nex-acceptance-pipe-'));
  const bridge = await startAcceptancePipe({ profile, dispatch: async request => { assert.equal(request.command, 'sourceModel'); return { sourceId: 'fixture', model: 'synthetic-model', protocol: 'openai', apiKey: 'synthetic-secret' }; } });
  try {
    const client = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/control-acceptance.ps1'), '-Profile', profile, '-Command', 'sourceModel'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    client.stdout.on('data', data => { stdout += data; }); client.stderr.on('data', data => { stderr += data; });
    const code = await new Promise(resolve => client.once('close', resolve));
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { ok: true, result: { sourceId: 'fixture', model: 'synthetic-model', protocol: 'openai' } });
    assert.ok(!stdout.includes('synthetic-secret'));
  } finally {
    await bridge.close();
    assert.equal(path.dirname(profile), os.tmpdir());
    rmSync(profile, { recursive: true, force: true });
  }
});

test('round-trips Chinese and emoji through sourceModel/prepare/status in a hidden PowerShell process', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'nex-pipe-中文-🧪-'));
  const names = ['导演雪夜🌨️', '编剧推门🚪', '美术灯笼🏮', '剪辑月色🌙', '审核完成✅'];
  const content = JSON.stringify({ title: '雪夜推门🌨️', lines: ['“雪落了。”😊', '门外有灯🏮'] });
  const scopeId = 'scope-fixture';
  const status = { scopeId, ready: false, reason: '价格未确认，禁止付费🛑', members: names.map((name, i) => ({ id: `bot-${i}`, conversation_id: `conv-${i}`, name })), reports: [{ id: 'report', bot_id: 'bot-0', task_id: 'task-fixture', seq: 1, role: 'assistant', kind: 'message', content }] };
  const bridge = await startAcceptancePipe({ profile, dispatch: async request => {
    if (request.command === 'sourceModel') return { sourceId: 'fixture', model: '合成模型-雪夜🌨️', protocol: 'openai', supplier: 'fixture.invalid', revision: 'fixture-revision', connectionVersion: 1 };
    if (request.command === 'prepare') { assert.deepEqual(request.args.names, names); assert.equal(request.args.root, path.join(profile, '新作品-雪夜🌨️')); return status; }
    assert.equal(request.command, 'status'); assert.equal(request.args, scopeId); return status;
  } });
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  async function hidden(command, args) {
    const argv = ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/control-acceptance.ps1'), '-Profile', profile, '-Command', command];
    if (args !== undefined) { const file = path.join(profile, '输入-🧪.json'); writeFileSync(file, JSON.stringify(args), 'utf8'); argv.push('-InputFile', file); }
    const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), argv, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let stderr = '';
    child.stdout.on('data', data => chunks.push(data)); child.stderr.on('data', data => { stderr += data; });
    assert.equal(await new Promise(resolve => child.once('close', resolve)), 0, stderr);
    const bytes = Buffer.concat(chunks);
    assert.ok(!bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'stdout must not add a BOM');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  try {
    const source = await hidden('sourceModel'); assert.equal(source.result.model, '合成模型-雪夜🌨️');
    const prepared = await hidden('prepare', { sourceId: source.result.sourceId, sourceRevision: source.result.revision, names, root: path.join(profile, '新作品-雪夜🌨️') });
    assert.deepEqual(prepared.result.members.map(row => row.name), names);
    const read = await hidden('status', scopeId);
    assert.equal(read.result.reason, status.reason); assert.equal(read.result.reports[0].content, content);
    assert.equal(read.result.reports[0].task_id, 'task-fixture'); assert.deepEqual(JSON.parse(read.result.reports[0].content), JSON.parse(content));
  } finally { await bridge.close(); assert.equal(path.dirname(profile), os.tmpdir()); rmSync(profile, { recursive: true, force: true }); }
});
