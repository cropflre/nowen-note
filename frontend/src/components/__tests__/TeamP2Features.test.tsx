import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockApi = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  getWorkspaceMembers: vi.fn(),
  getWorkspaceInvites: vi.fn(),
  getWorkspaceFeatures: vi.fn(),
  getWorkspaceGroups: vi.fn(),
  createWorkspaceGroup: vi.fn(),
  deleteWorkspaceGroup: vi.fn(),
  addWorkspaceGroupMember: vi.fn(),
  removeWorkspaceGroupMember: vi.fn(),
  getWorkspaceActivity: vi.fn(),
  getMe: vi.fn(),
  searchUsers: vi.fn(),
}));

const mockKnowledgeTreeApi = vi.hoisted(() => ({
  getPermissions: vi.fn(),
  setAccessMode: vi.fn(),
  setPermission: vi.fn(),
  clearPermission: vi.fn(),
  grantGroupPermission: vi.fn(),
  getEffectivePermission: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mockApi,
}));

vi.mock("@/lib/knowledgeTreeApi", () => ({
  knowledgeTreeApi: mockKnowledgeTreeApi,
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/components/ui/confirm", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.count !== undefined ? `${key}:${params.count}` : key,
    i18n: { language: "zh-CN", resolvedLanguage: "zh-CN" },
  }),
}));

vi.mock("@/components/WorkspaceSwitcher", () => ({
  Modal: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div role="dialog" aria-label={title}>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

import MembersPanel from "@/components/MembersPanel";
import KnowledgeTreePermissionsDialog from "@/components/KnowledgeTreePermissionsDialog";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

async function flushUi() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function setControlValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("团队 P2 前端集成（用户组、空间动态流、按组批量授权与权限诊断）", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    mockApi.getMe.mockResolvedValue({ id: "u-owner", username: "alice" });
    mockApi.getWorkspace.mockResolvedValue({
      id: "ws-1",
      name: "研发空间",
      description: "",
      icon: "🚀",
      ownerId: "u-owner",
      role: "owner",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    mockApi.getWorkspaceMembers.mockResolvedValue([
      {
        workspaceId: "ws-1",
        userId: "u-owner",
        role: "owner",
        joinedAt: "2026-01-01T00:00:00Z",
        username: "alice",
        email: null,
        avatarUrl: null,
      },
      {
        workspaceId: "ws-1",
        userId: "u-bob",
        role: "viewer",
        joinedAt: "2026-01-02T00:00:00Z",
        username: "bob",
        email: null,
        avatarUrl: null,
      },
    ]);
    mockApi.getWorkspaceInvites.mockResolvedValue([]);
    mockApi.getWorkspaceFeatures.mockResolvedValue({
      notes: true,
      diaries: true,
      tasks: true,
      mindmaps: true,
      files: true,
      favorites: true,
    });
    mockApi.getWorkspaceGroups.mockResolvedValue([
      {
        id: "grp-1",
        workspaceId: "ws-1",
        name: "产品组",
        description: "需求与设计",
        createdBy: "u-owner",
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
        memberCount: 1,
        members: [
          {
            groupId: "grp-1",
            userId: "u-bob",
            addedAt: "2026-01-03T00:00:00Z",
            username: "bob",
            displayName: "鲍勃",
            email: null,
          },
        ],
      },
    ]);
    mockApi.getWorkspaceActivity.mockResolvedValue({
      canViewPermissions: true,
      items: [
        {
          id: "kth:1",
          category: "permissions",
          action: "更新了目录权限",
          actorName: "alice",
          targetTitle: "设计规范",
          detail: "成员：鲍勃",
          createdAt: "2026-01-04T10:00:00Z",
        },
      ],
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("MembersPanel 支持用户组创建与空间动态权限审计筛选", async () => {
    mockApi.createWorkspaceGroup.mockResolvedValue({
      id: "grp-2",
      workspaceId: "ws-1",
      name: "后端组",
      description: "",
      createdBy: "u-owner",
      createdAt: "2026-01-05T00:00:00Z",
      updatedAt: "2026-01-05T00:00:00Z",
      memberCount: 0,
      members: [],
    });

    await act(async () => {
      root.render(<MembersPanel workspaceId="ws-1" onClose={() => {}} />);
    });
    await flushUi();

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const groupsTab = tabs.find((b) => b.textContent?.includes("用户组"));
    expect(groupsTab).toBeTruthy();

    await act(async () => {
      groupsTab!.click();
    });
    await flushUi();

    expect(host.textContent).toContain("产品组");
    expect(host.textContent).toContain("鲍勃");

    const nameInput = host.querySelector<HTMLInputElement>('input[aria-label="新用户组名称"]');
    expect(nameInput).toBeTruthy();
    await act(async () => {
      setControlValue(nameInput!, "后端组");
    });
    const submitBtn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("新建用户组"),
    );
    expect(submitBtn).toBeTruthy();
    await act(async () => {
      submitBtn!.click();
    });
    await flushUi();

    expect(mockApi.createWorkspaceGroup).toHaveBeenCalledWith("ws-1", {
      name: "后端组",
      description: undefined,
    });

    const activityTab = tabs.find((b) => b.textContent?.includes("空间动态"));
    expect(activityTab).toBeTruthy();
    await act(async () => {
      activityTab!.click();
    });
    await flushUi();

    expect(host.textContent).toContain("设计规范");

    const permFilter = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "权限审计",
    );
    expect(permFilter).toBeTruthy();
    await act(async () => {
      permFilter!.click();
    });
    await flushUi();

    expect(mockApi.getWorkspaceActivity).toHaveBeenCalledWith("ws-1", "permissions", 40);
  });

  it("KnowledgeTreePermissionsDialog 支持按用户组批量授权与成员生效权限诊断", async () => {
    const node = {
      id: "node-1",
      userId: "u-owner",
      workspaceId: "ws-1",
      scopeKey: "ws:ws-1",
      parentId: null,
      nodeType: "folder",
      resourceType: "notebook",
      resourceId: "nb-1",
      title: "产品需求库",
      sortOrder: 0,
      isExpanded: 1,
      isDeleted: 0,
      childCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      access: {
        nodeId: "node-1",
        rolePreset: "admin",
        source: "owner",
        sourceNodeId: null,
        capabilities: {
          canView: true,
          canComment: true,
          canCreate: true,
          canEdit: true,
          canDelete: true,
          canMove: true,
          canDownload: true,
          canReshare: true,
          canManageMembers: true,
        },
      },
    } as KnowledgeTreeNode;

    mockKnowledgeTreeApi.getPermissions.mockResolvedValue({
      direct: [],
      inheritsFromParent: null,
      accessMode: "inherit",
      isExplicit: false,
      currentUserAccess: node.access,
    });
    mockKnowledgeTreeApi.grantGroupPermission.mockResolvedValue({
      success: true,
      groupId: "grp-1",
      groupName: "产品组",
      rolePreset: "maintainer",
      appliedCount: 1,
    });
    mockKnowledgeTreeApi.getEffectivePermission.mockResolvedValue({
      user: { id: "u-bob", username: "bob", displayName: "鲍勃" },
      workspaceRole: "viewer",
      sourceNodeTitle: null,
      explanation: "来自当前节点的独立授权（预设：maintainer），覆盖工作区默认角色",
      effective: {
        nodeId: "node-1",
        rolePreset: "maintainer",
        source: "direct",
        sourceNodeId: "node-1",
        capabilities: {
          canView: true,
          canComment: true,
          canCreate: true,
          canEdit: true,
          canDelete: true,
          canMove: true,
          canDownload: true,
          canReshare: false,
          canManageMembers: false,
        },
      },
    });

    const onChanged = vi.fn();
    await act(async () => {
      root.render(
        <KnowledgeTreePermissionsDialog
          node={node}
          onClose={() => {}}
          onChanged={onChanged}
        />,
      );
    });
    await flushUi();

    const dialog = document.body.querySelector('[data-knowledge-tree-permissions-dialog="true"]')!;
    expect(dialog).toBeTruthy();

    const groupBtn = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("按用户组授权"),
    );
    expect(groupBtn).toBeTruthy();
    await act(async () => {
      groupBtn!.click();
    });
    await flushUi();

    const groupSelect = dialog.querySelector<HTMLSelectElement>('select[aria-label="选择要授权的用户组"]');
    const roleSelect = dialog.querySelector<HTMLSelectElement>('select[aria-label="用户组授权角色"]');
    expect(groupSelect).toBeTruthy();
    expect(roleSelect).toBeTruthy();
    await act(async () => {
      setControlValue(groupSelect!, "grp-1");
      setControlValue(roleSelect!, "maintainer");
    });

    const grantSubmit = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "批量授权",
    );
    expect(grantSubmit).toBeTruthy();
    await act(async () => {
      grantSubmit!.click();
    });
    await flushUi();

    expect(mockKnowledgeTreeApi.grantGroupPermission).toHaveBeenCalledWith(
      "node-1",
      "grp-1",
      "maintainer",
    );
    expect(onChanged).toHaveBeenCalledWith("permission-group-granted");

    const diagBtn = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("检查成员最终权限"),
    );
    expect(diagBtn).toBeTruthy();
    await act(async () => {
      diagBtn!.click();
    });
    await flushUi();

    const diagSelect = dialog.querySelector<HTMLSelectElement>(
      'select[aria-label="选择要诊断生效权限的成员"]',
    );
    expect(diagSelect).toBeTruthy();
    await act(async () => {
      setControlValue(diagSelect!, "u-bob");
    });
    await flushUi();

    expect(dialog.textContent).toContain("来自当前节点的独立授权");
    expect(dialog.querySelector('[aria-label="编辑：允许"]')).toBeTruthy();
    expect(dialog.querySelector('[aria-label="管理成员：不允许"]')).toBeTruthy();
  });
});
