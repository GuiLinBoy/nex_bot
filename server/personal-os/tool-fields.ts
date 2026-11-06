import { Type } from "typebox";
import { Check } from "typebox/value";

// Shared field types for the registered Broker and on-demand action schemas.
export const toolFields = Type.Object({ action: Type.String(), todoId: Type.Optional(Type.String()), description: Type.Optional(Type.String()), owner: Type.Optional(Type.String()), date: Type.Optional(Type.String()), priority: Type.Optional(Type.String()), steps: Type.Optional(Type.Array(Type.Object({ text: Type.String(), done: Type.Boolean() }))), modelId: Type.Optional(Type.String()), size: Type.Optional(Type.String()), attachmentId: Type.Optional(Type.String()), connectorId: Type.Optional(Type.String()), connectorVersion: Type.Optional(Type.Integer()), tool: Type.Optional(Type.String()), risk: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("dangerous")])), riskReason: Type.Optional(Type.String()), skillId: Type.Optional(Type.String()), operation: Type.Optional(Type.String()), parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())), query: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })), documentId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), content: Type.Optional(Type.String()), scope: Type.Optional(Type.String()), patch: Type.Optional(Type.Record(Type.String(), Type.Unknown())), expectedVersion: Type.Optional(Type.Integer()), quote: Type.Optional(Type.String()), on: Type.Optional(Type.Boolean()), role: Type.Optional(Type.String()), bot: Type.Optional(Type.String()), op: Type.Optional(Type.String()), topic: Type.Optional(Type.String()), topics: Type.Optional(Type.Array(Type.String())), to: Type.Optional(Type.String()), into: Type.Optional(Type.String()), moveId: Type.Optional(Type.String()), anchor: Type.Optional(Type.String()), aliases: Type.Optional(Type.Array(Type.String())), summary: Type.Optional(Type.String()), botId: Type.Optional(Type.String()), message: Type.Optional(Type.String()), instructions: Type.Optional(Type.String()), expertise: Type.Optional(Type.Array(Type.String())), deviceId: Type.Optional(Type.String()), path: Type.Optional(Type.String()), command: Type.Optional(Type.String()), routineId: Type.Optional(Type.String()), name: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()), scheduleKind: Type.Optional(Type.String()), taskKind: Type.Optional(Type.Union([Type.Literal("reminder"), Type.Literal("monitor"), Type.Literal("report"), Type.Literal("action")])), runAt: Type.Optional(Type.Integer()), delaySeconds: Type.Optional(Type.Integer()), intervalMinutes: Type.Optional(Type.Number()), localTime: Type.Optional(Type.String()), timeZone: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()) });

/** Explain field types without echoing commands, credentials or other argument values. */
export function toolArgumentError(args: unknown): string | undefined {
  if (Check(toolFields, args)) return;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "工具参数类型无效：需要对象。请用 tool.search 查询用法";
  const values = args as Record<string, unknown>;
  const invalid = Object.entries(toolFields.properties).filter(([key, schema]) =>
    (key === "action" || Object.hasOwn(values, key)) && !Check(schema, values[key]));
  const fields = invalid.slice(0, 8).map(([key, schema]) => {
    const value = values[key];
    const received = value === null ? "null" : Number.isNaN(value) ? "NaN"
      : typeof value === "number" && !Number.isFinite(value) ? "非有限 number" : Array.isArray(value) ? "array" : typeof value;
    return `${key} 需要 ${"type" in schema ? schema.type : "工具定义的类型"}（收到 ${received}）`;
  });
  return `工具参数类型无效：${fields.join("；") || "请按工具定义填写"}。请用 tool.search 查询用法并修正参数`;
}
