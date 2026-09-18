export type PluginStudioProjectStatus = "draft" | "ready" | "archived";
export type PluginStudioFileEncoding = "utf8" | "base64";

export interface PluginStudioProject {
  id: string;
  ownerUserId: string;
  name: string;
  slug: string;
  status: PluginStudioProjectStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PluginStudioProjectFile {
  path: string;
  size: number;
  mimeType: string;
  encoding: PluginStudioFileEncoding;
}

export interface PluginStudioFileContent extends PluginStudioProjectFile {
  content: string;
}

export interface PluginStudioActor {
  userId: string;
  isAdmin: boolean;
}

export interface PluginStudioWriteFileInput {
  path: string;
  content: string;
  encoding?: PluginStudioFileEncoding;
  expectedRevision: number;
}

export class PluginStudioError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "PluginStudioError";
  }
}
