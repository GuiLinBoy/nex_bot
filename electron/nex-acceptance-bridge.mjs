import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const commands = new Set(['sourceModel', 'prepare', 'status', 'send', 'attach', 'stop']);
export function acceptancePipeName(profile) { return 'nex-acceptance-' + createHash('sha256').update(path.resolve(profile).toLowerCase()).digest('hex').slice(0, 24); }
export function validateAcceptanceCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !commands.has(value.command) || Object.keys(value).some(key => !['command', 'args'].includes(key))) throw new Error('Invalid acceptance command');
  if (value.command === 'sourceModel') { if (value.args !== undefined) throw new Error('Invalid arguments'); }
  else if (value.command === 'status') { if (typeof value.args !== 'string' || value.args.length > 100) throw new Error('Invalid scope'); }
  else if (!value.args || typeof value.args !== 'object' || Array.isArray(value.args)) throw new Error('Invalid arguments');
  return value;
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key) && (value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key]))).map(key => [key, value[key]]));
export function acceptanceDto(command, value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid acceptance result');
  if (command === 'sourceModel') {
    const source = pick(value, ['sourceId', 'workspaceId', 'model', 'protocol', 'supplier', 'connectionVersion', 'revision', 'contextWindow']);
    if (Object.hasOwn(value, 'device')) source.device = value.device === null ? null : pick(value.device, ['id', 'name', 'platform', 'hostname', 'acceptanceExec', 'exec']);
    return source;
  }
  if (command === 'send') return pick(value, ['taskId']);
  if (command === 'stop') return { ok: value.ok === true };
  if (command === 'attach') return pick(value, ['id', 'botId', 'name', 'mime', 'size']);
  const result = pick(value, ['scopeId', 'ready', 'reason', 'budgetMode', 'quotaError', 'attempts', 'heldCnyMicros', 'chargedUpperCnyMicros']);
  result.limits = pick(value.limits, ['calls', 'cnyMicros', 'maxOutput']);
  result.model = pick(value.model, ['id', 'protocol', 'supplier', 'connectionVersion']);
  for (const [key, fields] of Object.entries({ members: ['id', 'conversation_id', 'name'], tasks: ['id', 'bot_id', 'conversation_id', 'status', 'result_summary'], reports: ['id', 'bot_id', 'task_id', 'seq', 'role', 'kind', 'content'], operations: ['id', 'task_id', 'bot_id', 'tool_name', 'status'] })) result[key] = Array.isArray(value[key]) ? value[key].slice(0, 100).map(row => pick(row, fields)) : [];
  return result;
}
export async function forwardAcceptance(window, origin, request) {
  validateAcceptanceCommand(request);
  if (!window || window.isDestroyed() || !origin || new URL(window.webContents.getURL()).origin !== origin) throw new Error('Authenticated renderer unavailable');
  const frame = window.webContents.mainFrame;
  const code = `globalThis.nexAcceptance[${JSON.stringify(request.command)}](${request.args === undefined ? '' : JSON.stringify(request.args)})`;
  // The expression is generated exclusively from a fixed method enum + JSON.
  // Neither this API nor the pipe accepts JavaScript source or an IPC name.
  const value = await window.webContents.executeJavaScript(code);
  if (window.isDestroyed() || window.webContents.mainFrame !== frame || new URL(window.webContents.getURL()).origin !== origin) throw new Error('Renderer changed');
  return acceptanceDto(request.command, value);
}
export async function startAcceptancePipe({ profile, dispatch }) {
  if (process.platform !== 'win32') throw new Error('Acceptance pipe requires Windows');
  const pipeName = acceptancePipeName(profile);
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = fileURLToPath(new URL('./acceptance-pipe-server.ps1', import.meta.url)).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-PipeName', pipeName], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  let exited = false;
  child.once('exit', () => { exited = true; });
  const lines = createInterface({ input: child.stdout });
  let ready = false;
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Acceptance pipe did not start')), 15000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Acceptance pipe unavailable')); });
    child.once('exit', () => { clearTimeout(timer); if (!ready) reject(new Error('Acceptance pipe unavailable')); });
    lines.on('line', async line => {
      if (!ready) { try { const state = JSON.parse(line); if (state.type === 'ready' && state.currentUserOnly === true) { ready = true; clearTimeout(timer); resolve(); } } catch {} return; }
      let requestTimer;
      try {
        if (line.length > 8000000) throw new Error('Too large');
        const request = validateAcceptanceCommand(JSON.parse(line));
        const value = await Promise.race([dispatch(request), new Promise((_, reject) => { requestTimer = setTimeout(() => reject(new Error('Timeout')), 30000); })]);
        child.stdin.write(JSON.stringify({ ok: true, result: acceptanceDto(request.command, value) }) + '\n');
      } catch { child.stdin.write('{"ok":false,"error":"Acceptance command rejected"}\n'); }
      finally { clearTimeout(requestTimer); }
    });
  });
  try { await started; } catch (error) { child.kill(); throw error; }
  return { pipeName, async close() { lines.close(); child.kill(); await new Promise(resolve => { if (exited) resolve(); else child.once('exit', resolve); }); } };
}
