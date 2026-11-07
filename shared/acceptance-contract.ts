export interface AcceptanceSource { sourceId: string; workspaceId: string; model: string; protocol: string; supplier: string; connectionVersion: number; revision: string; contextWindow: number; device: { id: string; name: string; platform: string; hostname: string; acceptanceExec: boolean; exec: boolean } | null }
export interface AcceptanceStatus {
  scopeId: string; ready: boolean; reason: string | null;
  budgetMode: 'cny-upper-bound' | 'prepaid-quota'; quotaError: string | null;
  limits: { calls: number; cnyMicros: number | null; maxOutput: number };
  model: { id: string; protocol: string; supplier: string; connectionVersion: number };
  attempts: number; heldCnyMicros: number | null; chargedUpperCnyMicros: number | null;
  members: Array<{ id: string; conversation_id: string; name: string }>;
  tasks: Array<{ id: string; bot_id: string; conversation_id: string; status: string; result_summary: string | null }>;
  reports: Array<{ id: string; bot_id: string; task_id: string | null; seq: number; role: string; kind: string; content: string }>;
  operations: Array<{ id: string; task_id: string; bot_id: string; tool_name: string; status: string }>;
}
