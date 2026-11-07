// Narrow, same-origin renderer bridge. No credential/configuration accessor,
// arbitrary URL, JS execution, SQL or direct device execution is exposed.
import type { AcceptanceSource, AcceptanceStatus } from '../../shared/acceptance-contract.ts';

export function createAcceptanceBridge(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
  async function command<T>(name: string, data: object): Promise<T> {
    const response = await fetchImpl(`/api/acceptance/${name}`, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : '验收请求失败');
    return result as T;
  }
  return Object.freeze({
    sourceModel: async () => {
      const local = await (globalThis as typeof globalThis & { nex?: { deviceState?: () => Promise<{ deviceId?: string }> } }).nex?.deviceState?.();
      return command<AcceptanceSource>('source-model', { sourceName: 'my_win', ...(local?.deviceId ? { deviceId: local.deviceId } : {}) });
    },
    prepare: (data: { sourceId: string; sourceRevision: string; names: string[]; root: string }) => command<AcceptanceStatus>('prepare', data),
    status: (scopeId: string) => command<AcceptanceStatus>('status', { scopeId }),
    attach: (data: { scopeId: string; botId: string; name: string; data: string }) => command<{ id: string; botId: string; name: string; mime: string; size: number }>('attach', data),
    send: (data: { scopeId: string; botId: string; clientId: string; text: string; attachments?: string[] }) => command<{ taskId: string }>('send', data),
    stop: (data: { scopeId: string; taskId?: string }) => command<{ ok: true }>('stop', data),
  });
}
export function installAcceptanceBridge(target: object = globalThis) {
  Object.defineProperty(target, 'nexAcceptance', { value: createAcceptanceBridge(), writable: false, configurable: false });
}
