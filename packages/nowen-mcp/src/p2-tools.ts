import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NowenApiClient } from "./api-client.js";

type WorkflowOperation = "create" | "update" | "enable" | "disable" | "delete";
type PlanParams = {
  operation: WorkflowOperation; workflowId?: string; name?: string;
  description?: string; definition?: unknown;
};
const shape = {
  operation: z.enum(["create", "update", "enable", "disable", "delete"]),
  workflowId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  definition: z.unknown().optional().describe("工作流 V1 定义，包含 version=1、trigger 与 steps"),
};
const send = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] });
const errorResult = (error: unknown) => ({
  content: [{ type: "text" as const, text: `错误: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true as const,
});
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function dangerous(definition: any): boolean {
  return definition?.trigger?.type === "webhook"
    || (Array.isArray(definition?.steps) && definition.steps.some((step: any) => step?.type === "action"));
}
function verifyDefinition(definition: any): void {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)
    || definition.version !== 1 || !definition.trigger || !Array.isArray(definition.steps)
    || definition.steps.length < 1 || definition.steps.length > 50) {
    throw new Error("请提供有效的 V1 工作流 trigger 和 1–50 个步骤");
  }
  if (dangerous(definition) && process.env.MCP_ENABLE_DANGEROUS_TOOLS !== "true") {
    throw new Error("含插件 Action 或 Webhook 的工作流需要显式设置 MCP_ENABLE_DANGEROUS_TOOLS=true");
  }
}
async function plan(api: NowenApiClient, params: PlanParams) {
  const { operation, workflowId, name, description, definition } = params;
  if (operation !== "create" && !workflowId) throw new Error("请指定 workflowId");
  const before = workflowId ? await api.getWorkflow(workflowId) : null;
  if (before && before.workspaceId != null) throw new Error("只允许管理个人工作流");
  if ((operation === "create" || operation === "update") && !(name || before?.name)?.trim()) {
    throw new Error("请填写工作流名称");
  }
  const nextDefinition = operation === "create" || operation === "update"
    ? (definition ?? before?.definition) : before?.definition;
  if (operation === "create" || operation === "update" || operation === "enable") {
    verifyDefinition(nextDefinition);
  }
  if (operation === "update" && before?.enabled) {
    // Existing workflow update resets enabled=false. Require explicit disable in the UI.
    throw new Error("更新已启用的工作流前，请先预览并停用它");
  }
  const normalized = {
    operation, workflowId: workflowId ?? null, name: name ?? before?.name ?? null,
    description: description ?? before?.description ?? "",
    definition: nextDefinition ?? null,
  };
  const expectedRevision = before?.revision ?? null;
  const revision = hash([normalized, expectedRevision]);
  return {
    revision, expectedRevision,
    before: before ? { id: before.id, name: before.name, enabled: before.enabled,
      updatedAt: before.updatedAt, trigger: before.trigger, revision: before.revision } : null,
    after: { name: normalized.name, description: normalized.description, definition: nextDefinition,
      enabled: operation === "enable" ? true : operation === "disable" ? false : false },
    normalized,
  };
}

export function registerP2Tools(server: McpServer, api: NowenApiClient): void {
  server.tool("nowen_get_workflow", "获取本人工作流定义、状态及修订版本", {
    workflowId: z.string().min(1),
  }, async ({ workflowId }) => {
    try { const item = await api.getWorkflow(workflowId);
      if (item.workspaceId != null) throw new Error("仅支持个人工作流");
      return send(item);
    } catch (error) { return errorResult(error); }
  });

  server.tool("nowen_list_workflow_runs", "获取本人个人工作流最近的运行记录（只读）", {
    workflowId: z.string().min(1),
  }, async ({ workflowId }) => {
    try { const item = await api.getWorkflow(workflowId);
      if (item.workspaceId != null) throw new Error("仅支持个人工作流");
      return send(await api.listWorkflowRuns(workflowId));
    } catch (error) { return errorResult(error); }
  });

  server.tool("nowen_preview_workflow_change",
    "预览个人自动化工作流创建、编辑、启停或删除（仅预览，不执行）",
    shape, async (params) => {
      try {
        const p = await plan(api, params);
        return send({ dryRun: true, ...p, nextStep:
          "向用户展示触发条件、步骤和启用状态，得到确认后调用 nowen_apply_workflow_change，提交 revision 与确认词。" });
      } catch (error) { return errorResult(error); }
    });

  server.tool("nowen_apply_workflow_change",
    "确认后执行个人工作流变更；执行前再次验证预览指纹及后端版本，禁止未经确认的删除",
    { ...shape,
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      confirmation: z.enum(["APPLY_WORKFLOW_CHANGE", "DELETE_WORKFLOW"]),
    }, async (params) => {
      try {
        const p = await plan(api, params);
        if (p.revision !== params.expectedRevision) throw new Error("工作流已变化，请重新预览");
        const required = params.operation === "delete" ? "DELETE_WORKFLOW" : "APPLY_WORKFLOW_CHANGE";
        if (params.confirmation !== required) throw new Error("缺少本次操作的明确确认");
        const id = params.workflowId!;
        let result: any;
        if (params.operation === "create") {
          result = await api.createWorkflow({ name: p.normalized.name, description: p.normalized.description,
            workspaceId: null, definition: p.after.definition, ignoreSync: true, ignoreBulk: true });
        } else if (params.operation === "update") {
          result = await api.updateWorkflow(id, { name: p.normalized.name, description: p.normalized.description,
            workspaceId: null, definition: p.after.definition, ignoreSync: true, ignoreBulk: true,
            expectedRevision: p.expectedRevision });
        } else if (params.operation === "enable" || params.operation === "disable") {
          result = await api.setWorkflowEnabled(id, params.operation === "enable", p.expectedRevision!);
        } else {
          result = await api.deleteWorkflow(id, p.expectedRevision!);
        }
        // Do not expose one-time Webhook credentials in AI responses.
        if (result && typeof result === "object" && "webhookCredentials" in result) {
          result = { ...result, webhookCredentials: "[redacted]" };
        }
        return send({ applied: true, operation: params.operation, result });
      } catch (error) { return errorResult(error); }
    });

  server.tool("nowen_mcp_diagnostics",
    "显示 MCP 连接能力、授权限制、工具数量和接入模式；永不输出 Token 或密码",
    {}, async () => {
      const scopeConfigured = Object.prototype.hasOwnProperty.call(process.env, "ALLOWED_NOTEBOOK_IDS");
      return send({
        transport: process.env.NOWEN_MCP_TRANSPORT || "stdio",
        accessMode: process.env.MCP_ACCESS_MODE === "read-only" ? "read-only" : "read-write",
        credentialConfigured: Boolean(process.env.NOWEN_API_TOKEN || (process.env.NOWEN_USERNAME && process.env.NOWEN_PASSWORD)),
        notebookScopeConfigured: scopeConfigured,
        includeDescendants: process.env.MCP_INCLUDE_DESCENDANTS === "true",
        dangerousToolsEnabled: process.env.MCP_ENABLE_DANGEROUS_TOOLS === "true",
        supportedCapabilities: ["notes", "knowledge-tree", "personal-files", "tasks", "personal-automations"],
        warnings: [
          "个人自动化 Token 必须配置 automations:read 或 automations:write",
          "远程 HTTP 使用独立网关密钥；网关密钥不是 Nowen API Token",
          "删除、激活及编辑工作流必须先预览并确认",
        ],
      });
    });
}
