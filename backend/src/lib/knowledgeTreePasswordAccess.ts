import crypto from "node:crypto";
import jwt from "jsonwebtoken";

import { JWT_SECRET } from "./auth-security.js";

const FOLDER_UNLOCK_SECRET = crypto
  .createHmac("sha256", JWT_SECRET)
  .update("nowen-folder-unlock-v1")
  .digest("hex");

interface FolderUnlockTokenPayload {
  typ: "folder-unlock";
  userId: string;
  nodeId: string;
  notebookId: string;
  passwordVersion: number;
  iat?: number;
  exp?: number;
}

export function signFolderUnlockToken(input: {
  userId: string;
  nodeId: string;
  notebookId: string;
  passwordVersion: number;
}): string {
  return jwt.sign({ typ: "folder-unlock", ...input }, FOLDER_UNLOCK_SECRET, { expiresIn: "12h" });
}

export function verifyFolderUnlockToken(
  token: string,
  expected: {
    userId: string;
    nodeId: string;
    notebookId: string;
    passwordVersion: number;
  },
): boolean {
  try {
    const payload = jwt.verify(token, FOLDER_UNLOCK_SECRET) as FolderUnlockTokenPayload;
    return payload.typ === "folder-unlock"
      && payload.userId === expected.userId
      && payload.nodeId === expected.nodeId
      && payload.notebookId === expected.notebookId
      && payload.passwordVersion === expected.passwordVersion;
  } catch {
    return false;
  }
}

export function parseFolderUnlockTokens(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 100);
}
