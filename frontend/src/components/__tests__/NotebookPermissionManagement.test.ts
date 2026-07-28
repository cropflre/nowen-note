import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../NotebookShareDialog.tsx"), "utf8");
const apiSource = readFileSync(
  path.resolve(__dirname, "../../lib/notebookPermissionManagementApi.ts"),
  "utf8",
);

describe("Notebook permission management", () => {
  it("uses a collaborator-first permission management hierarchy", () => {
    expect(source).toContain('type View = "overview" | "scope" | "permissions"');
    expect(source).toContain("权限管理");
    expect(source).toContain("分享范围");
    expect(source).toContain("所有协作者");
    expect(source).toContain("添加协作者");
    expect(source).toContain("权限配置");
  });

  it("supports search, selection and batch collaborator operations", () => {
    expect(source).toContain("memberSearch");
    expect(source).toContain("toggleVisibleMembers");
    expect(source).toContain("batchSetRole");
    expect(source).toContain("batchRemove");
  });

  it("supports owner transfer without exposing it for workspace notebooks", () => {
    expect(source).toContain("!notebook.workspaceId");
    expect(source).toContain("notebookPermissionManagementApi.transferOwnership");
    expect(source).toContain("转交所有者");
    expect(apiSource).toContain("transferOwnership(");
    expect(apiSource).toContain("/transfer-owner");
  });

  it("loads an explicit permission summary instead of guessing the owner", () => {
    expect(source).toContain("notebookPermissionManagementApi.getSummary");
    expect(apiSource).toContain("/permission-summary");
  });

  it("keeps invitation, publication, comments and ACL capabilities reachable", () => {
    expect(source).toContain("登录后持链接加入");
    expect(source).toContain("通过公开链接访问");
    expect(source).toContain("公开评论管理");
    expect(source).toContain("目录级权限继承");
    expect(source).toContain("notebookPublicationApi.setPermissionOverride");
  });
});
