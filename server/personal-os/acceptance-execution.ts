import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

export interface AcceptanceExecution {
  version: 1; scopeId: string; root: string; executable: string; args: string[];
  timeoutMs?: number;
  files: Array<{ path: string; sha256: string }>;
  runtimeExecutables?: string[];
  userDirectories?: Partial<Record<'USERPROFILE' | 'LOCALAPPDATA' | 'APPDATA' | 'HOME', string>>;
}
const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export function readAcceptance(file: { version: 1; path: string; sha256: string; offset?: number; limit?: number }) {
  if (file.version !== 1 || !path.isAbsolute(file.path) || normalize(realpathSync(file.path)) !== normalize(file.path)) throw new Error('受限读取清单无效');
  const bytes = readFileSync(file.path);
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) throw new Error('验收脚本哈希已变化');
  const offset = file.offset ?? 0, limit = file.limit ?? 24000;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 24000) throw new Error('验收文本分页范围无效');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (offset > content.length) throw new Error('验收文本偏移超出范围');
  const end = Math.min(offset + limit, content.length);
  return { path: file.path, sha256: file.sha256, content: content.slice(offset, end), offset, nextOffset: end < content.length ? end : null, totalCharacters: content.length, truncated: end < content.length };
}
/** Executes a trusted, hash-pinned manifest with fixed argv and cwd, never a shell.
 * Network isolation and script immutability must be provisioned separately; this
 * function does not claim to sandbox arbitrary programs or their file writes. */
export function executeAcceptance(manifest: AcceptanceExecution, timeout: number, signal?: AbortSignal): Promise<unknown> {
  if (manifest.version !== 1 || !path.isAbsolute(manifest.root) || !path.isAbsolute(manifest.executable)
    || !Array.isArray(manifest.args) || manifest.args.some(arg => typeof arg !== 'string') || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('受限执行清单无效');
  if (normalize(realpathSync(manifest.root)) !== normalize(manifest.root)) throw new Error('验收目录不能经过链接重定向');
  if (!manifest.files.some(file => normalize(file.path) === normalize(manifest.executable))) throw new Error('执行器未锁定哈希');
  for (const file of manifest.files) {
    if (!path.isAbsolute(file.path) || normalize(realpathSync(file.path)) !== normalize(file.path)
      || createHash('sha256').update(readFileSync(file.path)).digest('hex') !== file.sha256.toLowerCase()) throw new Error('验收脚本或执行器哈希已变化');
  }
  const runtimes = manifest.runtimeExecutables ?? [];
  if (!Array.isArray(runtimes) || runtimes.some(file => typeof file !== 'string' || !path.isAbsolute(file) || !manifest.files.some(pinned => normalize(pinned.path) === normalize(file)))) throw new Error('运行时路径未锁定哈希');
  const directories = manifest.userDirectories ?? {};
  if (Object.entries(directories).some(([key, value]) => !['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME'].includes(key) || typeof value !== 'string' || !path.isAbsolute(value))) throw new Error('只允许显式的非秘密用户目录');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    Object.assign(env, directories);
    env.PATH = [...new Set(runtimes.map(file => path.dirname(file)))].join(path.delimiter);
    if (process.platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
    const child = spawn(manifest.executable, manifest.args, { cwd: manifest.root, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let ended = false, interrupted = false;
    const stop = () => {
      if (ended || !child.pid) return;
      interrupted = true;
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(stop, Math.max(1, timeout));
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const cleanup = () => { ended = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-16000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-16000); });
    child.once('error', () => { cleanup(); reject(new Error('受限脚本启动失败或已停止')); });
    child.once('close', (code, stopped) => { cleanup(); resolve({ stdout, stderr, exitCode: code, ...(code !== 0 || stopped || interrupted ? { error: '受限脚本失败或已停止' } : {}) }); });
  });
}
