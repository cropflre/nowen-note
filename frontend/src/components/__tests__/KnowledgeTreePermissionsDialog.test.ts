import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dialogPath = path.resolve(__dirname, "../KnowledgeTreePermissionsDialog.tsx");
const dialogSource = existsSync(dialogPath) ? readFileSync(dialogPath, "utf8") : "";
const treeSource = readFileSync(path.resolve(__dirname, "../KnowledgeTreePanel.tsx"), "utf8");
const quickSource = readFileSync(path.resolve(__dirname, "../MobileKnowledgeTreePanel.tsx"), "utf8");

describe("KnowledgeTreePermissionsDialog", () => {
  it("replaces the embedded permission panels with one shared modal", () => {
    expect(treeSource).toContain('import KnowledgeTreePermissionsDialog from "@/components/KnowledgeTreePermissionsDialog"');
    expect(quickSource).toContain('import KnowledgeTreePermissionsDialog from "@/components/KnowledgeTreePermissionsDialog"');
    expect(treeSource).not.toContain("function PermissionsPanel(");
    expect(quickSource).not.toContain("function PermissionsPanel(");
    expect(treeSource).toContain("<KnowledgeTreePermissionsDialog");
    expect(quickSource).toContain("<KnowledgeTreePermissionsDialog");
  });

  it("uses an accessible responsive portal dialog", () => {
    expect(dialogSource).toContain("createPortal(");
    expect(dialogSource).toContain('role="dialog"');
    expect(dialogSource).toContain('aria-modal="true"');
    expect(dialogSource).toContain('data-knowledge-tree-permissions-dialog="true"');
    expect(dialogSource).toContain("sm:max-w-[720px]");
  });

  it("supports member search, direct role changes and inheritance restoration", () => {
    expect(dialogSource).toContain("filteredRows");
    expect(dialogSource).toContain("updateMemberRole");
    expect(dialogSource).toContain("添加成员");
    expect(dialogSource).toContain("恢复继承");
    expect(dialogSource).toContain("移除成员");
    expect(dialogSource).toContain("ROLE_DESCRIPTIONS");
  });

  it("uses a searchable user picker instead of a free-form permission subject", () => {
    expect(dialogSource).toContain("UserPublicInfo");
    expect(dialogSource).toContain("api.searchUsers(");
    expect(dialogSource).toContain("userCandidates");
    expect(dialogSource).toContain("selectedUser");
    expect(dialogSource).toContain('role="listbox"');
    expect(dialogSource).toContain('role="option"');
    expect(dialogSource).toContain("已在成员列表中");
  });

  it("clears stale results and supports standard combobox keyboard navigation", () => {
    expect(dialogSource).toContain("activeCandidateIndex");
    expect(dialogSource).toContain('event.key === "ArrowDown"');
    expect(dialogSource).toContain('event.key === "ArrowUp"');
    expect(dialogSource).toContain("event.stopPropagation()");
    expect(dialogSource).toContain("aria-activedescendant");
    expect(dialogSource).toContain("setActiveCandidateIndex(-1)");
  });

  it("keeps the user dropdown closed after a member is added", () => {
    const saveStart = dialogSource.indexOf("await knowledgeTreeApi.setPermission(node.id, selectedUser.id, role)");
    const reloadStart = dialogSource.indexOf("await reload()", saveStart);
    expect(saveStart).toBeGreaterThan(-1);
    expect(reloadStart).toBeGreaterThan(saveStart);
    expect(dialogSource.slice(saveStart, reloadStart)).toContain("setCandidateOpen(false)");
    expect(dialogSource.slice(saveStart, reloadStart)).toContain("setFocusUserPicker(false)");
    expect(dialogSource).toContain("!candidateOpen");
    expect(dialogSource).toContain("autoFocus={focusUserPicker}");
  });

  it("prevents self-demotion and accurately describes direct permission removal", () => {
    expect(dialogSource).toContain("api.getMe()");
    expect(dialogSource).toContain("if (!currentUser)");
    expect(dialogSource).toContain("不能修改自己的权限");
    expect(dialogSource).toContain("下级节点已有的独立权限不会被删除");
  });
});
