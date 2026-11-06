import { createHash } from "node:crypto";

/** Only identical consecutive failures stop a turn; successful tools and new input reset it. */
export class ToolFailureGuard {
  private signature = "";
  private count = 0;
  private action = "broker";

  reset() { this.signature = ""; this.count = 0; }

  observe(toolName: string, args: Record<string, unknown> | undefined, failed: boolean, content: unknown) {
    if (!failed) { this.reset(); return; }
    // Native call IDs and message text are deliberately outside the signature.
    // Hash private argument/result values instead of retaining them in this guard.
    const signature = createHash("sha256").update(JSON.stringify({ toolName, args, content }, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
    this.count = signature === this.signature ? this.count + 1 : 1;
    this.signature = signature;
    const action = typeof args?.action === "string" ? args.action : toolName;
    this.action = /^[a-zA-Z0-9_.-]{1,80}$/.test(action) ? action : "broker";
  }

  reason(): string | undefined {
    if (this.count >= 3) return `同一工具调用（${this.action}）连续失败 3 次，已停止本轮，避免重复回复。请检查工具参数或模型服务后重试。`;
  }
}
