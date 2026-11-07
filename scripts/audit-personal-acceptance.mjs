// Offline audit only: no live URL, credential, filesystem-root or provider arguments.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { startFakeModel } from '../server/runtime/pi/p0/fake-model.ts';

if (process.argv.slice(2).some(arg => !arg.startsWith('--bundle=') && !arg.startsWith('--build-output='))) throw new Error('Only --bundle and --build-output are supported');
const bundle = process.argv.slice(2).find(arg => arg.startsWith('--bundle='))?.slice(9);
const buildOutput = process.argv.slice(2).find(arg => arg.startsWith('--build-output='))?.slice(15);
const dir = mkdtempSync(path.join(os.tmpdir(), 'nex-acceptance-audit-'));
const model = await startFakeModel();
let app;
const evidence = { fixture: dir, cases: [], liveRequests: 0 };
try {
  // Build away from dist-personal and the running client. Same bundle target as build-personal.
  const source = fileURLToPath(new URL('../server/personal-os/', import.meta.url));
  const outdir = path.join(dir, 'build');
  if (!bundle) {
    await build({ entryPoints: ['index.ts', 'worker.ts'].map(file => path.join(source, file)), outdir, bundle: true, platform: 'node', target: 'node22', format: 'esm',
      define: { PI_BUNDLED_NODE: 'true' }, external: ['pdfjs-dist/legacy/build/pdf.mjs'],
      banner: { js: "import { createRequire as nexCreateRequire } from 'node:module'; const require = nexCreateRequire(import.meta.url);" } });
    for (const file of ['schema.sql', 'node-schema.sql', 'agent-schema.sql', 'memory-schema.sql', 'memory-lifecycle-schema.sql', 'client-schema.sql', 'task-control-schema.sql', 'identity-schema.sql']) cpSync(path.join(source, file), path.join(outdir, file));
  }
  const { createPersonalApp } = await import(pathToFileURL(bundle ? path.resolve(bundle) : path.join(outdir, 'index.js')).href);
  if (!bundle) evidence.build = { target: 'node22', format: 'esm', files: Object.fromEntries(['index.js', 'worker.js'].map(file => [file, createHash('sha256').update(readFileSync(path.join(outdir, file))).digest('hex')])) };
  if (buildOutput) {
    assert.ok(!bundle, '--build-output requires a new isolated build');
    const destination = path.resolve(buildOutput), releaseRoot = fileURLToPath(new URL('../release/', import.meta.url));
    assert.ok(path.relative(releaseRoot, destination) && !path.relative(releaseRoot, destination).startsWith('..') && !path.isAbsolute(path.relative(releaseRoot, destination)), 'Build output must be inside repository release/');
    assert.ok(!existsSync(destination), 'Never replace an existing artifact');
    mkdirSync(destination, { recursive: true });
    for (const file of readdirSync(outdir)) copyFileSync(path.join(outdir, file), path.join(destination, file));
    evidence.buildOutput = destination;
  }
  app = await createPersonalApp({ dir, key: randomBytes(32), token: 'synthetic-audit', identity: false, hostDevice: false, memoryRuntime: false,
    modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} } });
  const origin = app.origin;
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  app.store.saveConfig({ provider: 'openai', endpoint: model.origin + '/v1', model: 'fixture-model', apiKey: 'synthetic-provider-key', contextWindow: 90000, maxOutputTokens: 8192 });
  const call = async (route, data, cookie = true) => {
    const response = await fetch(origin + '/api/' + route, { redirect: 'error', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'nex=synthetic-audit' } : {}) },
      ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('state', undefined, false)).status, 401);
  evidence.cases.push('unauthenticated-api-401');
  // Synthetic sentinels represent existing assistants; never point this audit at user data.
  const preserved = ['my_win', 'my_mac'].map(name => app.store.createBot(name));
  const before = preserved.map(id => app.store.get('SELECT * FROM bots WHERE id=?', id));
  const bots = [];
  for (let i = 0; i < 5; i++) {
    const created = await call('bots', { name: `隔离验收-${i}` });
    assert.equal(created.status, 200);
    const bot = created.body.id;
    bots.push(bot);
    model.scripts.push({ kind: 'openai-tool', calls: [{ id: `call-${randomUUID()}`, name: 'broker', args: JSON.stringify({ action: 'device.inventory' }) }] });
    model.scripts.push({ kind: 'openai-text', text: `合成回报-${i}` });
    const input = { botId: bot, text: `合成任务-${i}`, clientId: randomUUID() };
    const sent = await call('agents/input', input);
    assert.equal(sent.status, 202);
    const deadline = Date.now() + 25000;
    while (app.store.get('SELECT ended_at FROM tasks WHERE id=?', sent.body.taskId)?.ended_at == null || app.runtime.workers.size) {
      if (Date.now() > deadline) throw new Error('Isolated task timed out');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const task = app.store.get('SELECT * FROM tasks WHERE id=?', sent.body.taskId);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.legacy_max_model_calls, 1);
    assert.equal(app.store.get('SELECT COUNT(*) n FROM model_invocations m JOIN task_runs r ON r.id=m.run_id WHERE r.task_id=?', task.id).n, 2);
    assert.equal(app.store.get("SELECT COUNT(*) n FROM tool_calls WHERE task_id=? AND tool_name='device.inventory' AND status='succeeded'", task.id).n, 1);
    const messages = await call(`agents/messages?bot=${encodeURIComponent(bot)}`);
    assert.equal(messages.status, 200);
    assert.ok(messages.body.messages.some(message => message.content === `合成回报-${i}`));
    assert.equal((await call('agents/input', input)).body.taskId, sent.body.taskId);
  }
  assert.equal(new Set(app.store.all('SELECT conversation_id FROM assistant_conversations').map(row => row.conversation_id)).size, 5);
  assert.deepEqual(preserved.map(id => app.store.get('SELECT * FROM bots WHERE id=?', id)), before);
  assert.equal(model.requests.length, 10);
  assert.ok(model.requests.every(request => new URL(request.url, model.origin).origin === model.origin));
  const outputs = model.requests.map(request => JSON.parse(request.body)).map(body => body.max_tokens ?? body.max_completion_tokens);
  assert.ok(outputs.every(value => value === 8192));
  evidence.cases.push('cookie-authenticated-business-protocol', 'five-fresh-assistants-and-distinct-conversations', 'actual-Pi-worker-and-broker-device-inventory', 'scoped-reports', 'idempotent-clientId-no-extra-request', 'synthetic-existing-assistants-unchanged');
  evidence.unscopedCompatibility = { legacyLimitOneAllowsTwoRequests: true, configuredOutput8192ReachesProvider: true };
  evidence.syntheticRequests = model.requests.length;
  evidence.passed = true;
  console.log(JSON.stringify(evidence));
} finally {
  await app?.close();
  await model.close();
  const resolved = path.resolve(dir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), 'Refusing unexpected fixture cleanup parent');
  assert.ok(path.basename(resolved).startsWith('nex-acceptance-audit-'), 'Refusing unexpected fixture cleanup directory');
  rmSync(resolved, { recursive: true, force: true });
}
