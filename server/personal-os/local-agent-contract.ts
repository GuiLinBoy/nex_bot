export const localAgentOperations = ["discover", "list", "start", "status", "send", "respond", "stop"] as const;
export type LocalAgentKind = "codex" | "claude";
export type AgentRequest = { id: string; kind: string; details: Record<string, unknown> };

export function agentObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地 Agent 参数须为对象");
  return value as Record<string, unknown>;
}
export function agentText(value: unknown, name: string, max = 16_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`本地 Agent 的 ${name} 无效`);
  return value;
}
/** Shared by Core and device; never accept arbitrary executables, argv or environment from a model. */
export function localAgentParameters(operation: unknown, value: unknown = {}) {
  if (!localAgentOperations.includes(operation as typeof localAgentOperations[number])) throw new Error("不支持的本地 Agent 操作");
  const p = agentObject(value);
  if (JSON.stringify(p).length > 64_000) throw new Error("本地 Agent 参数过大");
  const fields: Record<string, string[]> = {
    discover: [], list: [], start: ["agent", "cwd", "prompt"],
    status: ["sessionId", "after", "waitMs"], send: ["sessionId", "prompt"],
    respond: ["sessionId", "request", "allow", "answers"], stop: ["sessionId"],
  };
  if (Object.keys(p).some((key) => !fields[String(operation)].includes(key))) throw new Error("本地 Agent 含不支持的参数");
  if (!["discover", "list", "start"].includes(String(operation))) agentText(p.sessionId, "sessionId", 100);
  if (operation === "start") {
    if (p.agent !== "codex" && p.agent !== "claude") throw new Error("本地 Agent 仅支持 codex 和 claude");
    agentText(p.cwd, "cwd", 4096);
  }
  if (operation === "start" || operation === "send") agentText(p.prompt, "prompt");
  if (operation === "status") {
    for (const [key, max] of [["after", Number.MAX_SAFE_INTEGER], ["waitMs", 10_000]] as const)
      if (p[key] !== undefined && (!Number.isSafeInteger(p[key]) || Number(p[key]) < 0 || Number(p[key]) > max)) throw new Error(`本地 Agent 的 ${key} 无效`);
  }
  if (operation === "respond") {
    const request = agentObject(p.request);
    agentText(request.id, "request.id", 100); agentText(request.kind, "request.kind", 100); agentObject(request.details);
    if (typeof p.allow !== "boolean") throw new Error("本地 Agent 确认须指定 allow");
    if (p.answers !== undefined) {
      const answers = agentObject(p.answers);
      if (Object.values(answers).some((v) => !Array.isArray(v) || v.some((item) => typeof item !== "string" || item.length > 4000))) throw new Error("本地 Agent 回答无效");
    }
  }
  return p;
}
