import type { AgentWorkflowInput } from "./agentWorkflow";
export interface AgentTemplateConfig {
  name: string; input: Omit<AgentWorkflowInput, "templateId" | "templateRevision">;
  allowNote: boolean; allowTasks: boolean; toolIds: string[];
}
export interface AgentTemplate { id: string; name: string; revision: string; config: AgentTemplateConfig }
export interface AgentExtension { id: string; name: string; kind: "plugin" | "mcp"; destination: string; revision: string; inputSchema: Record<string, unknown> }
export interface AgentConnection { id: string; name: string; url: string; hasCredential: number; allowedTools: string; toolsJson: string }
export interface AgentAutomation { id: string; name: string; enabled: number; triggerType: string }
