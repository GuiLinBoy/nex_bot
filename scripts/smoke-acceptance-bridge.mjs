// Run with the isolated Electron binary. Never opens an existing client profile.
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startAcceptancePipe, forwardAcceptance } from '../electron/nex-acceptance-bridge.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'nex-acceptance-electron-'));
const profile = path.join(root, 'profile'); mkdirSync(profile);
app.setPath('userData', profile);
let core, window, pipe, requests = 0;
const provider = createServer((_req, response) => { requests++; response.writeHead(500); response.end('{}'); });
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
let lastRecord;
const record = value => { lastRecord = value; if (arg('result')) writeFileSync(path.resolve(arg('result')), JSON.stringify(value)); };
record({ stage: 'fixture-started' });
async function external(command, value) {
  const args = ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/control-acceptance.ps1'), '-Profile', profile, '-Command', command];
  if (value !== undefined) { const file = path.join(root, 'input.json'); writeFileSync(file, JSON.stringify(value)); args.push('-InputFile', file); }
  const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 0, stderr);
  assert.ok(!stdout.includes('synthetic-cookie') && !stdout.includes('synthetic-key'));
  return JSON.parse(stdout);
}
async function run() {
try {
  await app.whenReady();
  record({ stage: 'electron-ready' });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const { createPersonalApp } = await import(pathToFileURL(path.resolve(arg('core'))).href);
  core = await createPersonalApp({ dir: path.join(root, 'core'), key: randomBytes(32), token: 'synthetic-cookie', identity: false, memoryRuntime: false, hostDevice: false, uiDir: path.resolve(arg('ui')), modelCatalog: { fetchDisabled: true, readSnapshot: () => undefined, log: () => {} } });
  core.store.saveConfig({ provider: 'openai', endpoint: `http://127.0.0.1:${provider.address().port}/v1`, model: 'synthetic-model', apiKey: 'synthetic-key', contextWindow: 90000, maxOutputTokens: 8192 });
  const sourceBot = core.store.createBot('my_win'); core.agents.ensure(sourceBot);
  core.agents.publish(sourceBot, 'assistant', 'message', 'SYNTHETIC-OLD-CHAT', 'old');
  core.store.createBot('my_mac');
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'acceptance-' + randomBytes(12).toString('hex') } });
  await window.webContents.session.cookies.set({ url: core.origin, name: 'nex', value: 'synthetic-cookie', httpOnly: true, sameSite: 'strict', path: '/' });
  await window.loadURL(core.origin);
  record({ stage: 'renderer-loaded' });
  const deadline = Date.now() + 15000;
  while (!await window.webContents.executeJavaScript('Boolean(globalThis.nexAcceptance)')) { if (Date.now() > deadline) throw new Error('Renderer bridge did not boot'); await new Promise(resolve => setTimeout(resolve, 50)); }
  pipe = await startAcceptancePipe({ profile, dispatch: request => forwardAcceptance(window, core.origin, request) });
  const source = await external('sourceModel'); assert.equal(source.ok, true);
  const prepared = await external('prepare', { sourceId: source.result.sourceId, sourceRevision: source.result.revision, names: ['native-fixture-1','native-fixture-2','native-fixture-3','native-fixture-4','native-fixture-5'], root: path.join(root, 'new-work') });
  assert.equal(prepared.ok, true); assert.equal(prepared.result.ready, false);
  const status = await external('status', prepared.result.scopeId);
  assert.equal(status.result.members.length, 5); assert.equal(status.result.tasks.length, 0);
  assert.ok(!JSON.stringify(status).includes('SYNTHETIC-OLD-CHAT'));
  const rejected = await external('send', { scopeId: prepared.result.scopeId, botId: prepared.result.members[0].id, clientId: 'native-fixture-message', text: 'must not call a model without prices' });
  assert.equal(rejected.ok, false); assert.equal(requests, 0);
  assert.equal((await external('stop', { scopeId: prepared.result.scopeId })).ok, true);
  const evidence = { passed: true, cases: ['actual-external-PowerShell-client','current-user-ACL-pipe','actual-Electron-authenticated-renderer','same-origin-HttpOnly-cookie-not-exported','narrow-Core-source-prepare-status-stop','missing-price-send-rejected-zero-model-requests','no-old-chat-in-DTO'], realModelRequests: 0 };
  record(evidence); console.log(JSON.stringify(evidence));
} catch (error) { record({ passed: false, error: error.message }); console.error(error.message); process.exitCode = 1; }
finally {
  await pipe?.close(); window?.destroy(); await core?.close(); await new Promise(resolve => provider.close(resolve));
  assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('nex-acceptance-electron-'));
  // Chromium keeps LevelDB open until process exit on Windows. The owning Node
  // launcher validates and removes this exact fixture after Electron closes.
  record({ ...lastRecord, cleanupRoot: root }); app.exit(process.exitCode || 0);
}
}
void run();
