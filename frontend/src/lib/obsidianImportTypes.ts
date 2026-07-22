import type { ImportProgress } from "./importService";

export type ObsidianEntryKind = "note" | "image" | "video" | "audio" | "pdf" | "attachment" | "skipped";

export interface ObsidianEntry {
  relPath: string;
  vaultPath: string;
  fileName: string;
  notebookPath: string[];
  size: number;
  lastModified: number;
  kind: ObsidianEntryKind;
  selected: boolean;
  file: File;
  skipReason?: string;
}

export interface ObsidianScanResult {
  source: "folder" | "zip";
  rootFolderName: string;
  entries: ObsidianEntry[];
  stats: {
    notes: number;
    attachments: number;
    images: number;
    videos: number;
    pdfs: number;
    skipped: number;
    folders: number;
    totalBytes: number;
  };
}

export interface ObsidianImportOptions {
  rootName: string;
  onProgress?: (progress: ImportProgress) => void;
}

export interface ObsidianImportResult {
  success: boolean;
  noteCount: number;
  attachmentCount: number;
  errors: string[];
  warnings: string[];
  missingReferences: string[];
  ambiguousReferences: string[];
  unusedAttachmentCount: number;
}

export interface ObsidianAssetIndex {
  byPath: Map<string, ObsidianEntry>;
  byFoldedPath: Map<string, ObsidianEntry | null>;
  byBaseName: Map<string, ObsidianEntry[]>;
}

export type ObsidianReferenceStatus = "resolved" | "missing" | "ambiguous" | "external" | "note-link";

export interface ObsidianReferenceResolution {
  status: ObsidianReferenceStatus;
  rawTarget: string;
  normalizedTarget: string;
  entry?: ObsidianEntry;
  candidates?: string[];
}

export interface ObsidianReferencePlan {
  rawTarget: string;
  displayText: string;
  syntax: "obsidian-embed" | "markdown-image" | "markdown-link" | "html-asset";
  resolution: ObsidianReferenceResolution;
}
