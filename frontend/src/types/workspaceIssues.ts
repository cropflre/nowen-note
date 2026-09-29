export interface WorkspaceIssue {
  id: string;
  workspaceId: string;
  number: number;
  title: string;
  content: string;
  status: "open" | "closed";
  createdBy: string | null;
  closedBy: string | null;
  closedAt: string | null;
  relatedNoteId: string | null;
  relatedNote: { id: string; title: string } | null;
  authorName: string | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceIssueDetail extends WorkspaceIssue {
  canComment: boolean;
  canChangeStatus: boolean;
  canEdit: boolean;
}

export interface IssueActivity {
  id: string;
  issueId: string;
  userId: string | null;
  authorName: string | null;
  type: "comment" | "closed" | "reopened";
  parentId: string | null;
  content: string;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceNotification {
  id: string;
  userId: string;
  workspaceId: string;
  workspaceName: string;
  type: "issue_created" | "issue_commented" | "issue_closed" | "issue_reopened";
  actorName: string | null;
  resourceType: "workspace_issue";
  resourceId: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface IssueListResponse {
  items: WorkspaceIssue[];
  total: number;
  canCreate: boolean;
  role: string;
}

export interface NotificationListResponse {
  items: WorkspaceNotification[];
  total: number;
  unreadCount: number;
}
