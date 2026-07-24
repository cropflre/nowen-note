export type {
  EffectiveKnowledgeAccess,
  KnowledgeCapabilities,
  KnowledgeCapabilityName,
  KnowledgeRolePreset,
} from "./knowledgeCapabilitiesCore.js";

export {
  KNOWLEDGE_ROLE_PRESETS,
  capabilitiesToLegacyPermission,
  clearKnowledgeNodeRole,
  findKnowledgeNodeByResource,
  hasKnowledgeCapability,
  listKnowledgeNodeRoles,
  parseKnowledgeRolePreset,
  resolveKnowledgePermissionSubject,
  setKnowledgeNodeRole,
} from "./knowledgeCapabilitiesCore.js";

export {
  resolveKnowledgeNodeAccess,
  resolveResourceKnowledgeAccess,
} from "./knowledgeCapabilitiesResolver.js";
