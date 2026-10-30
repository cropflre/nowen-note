export interface AssetAISuggestion {
  id: string;
  filename: string;
  expected: string;
  folderId: string | null;
  newFolderName: string | null;
  tags: string[];
  description: string;
  reason: string;
}
export interface AssetAIPreview {
  items: AssetAISuggestion[];
  folders: Array<{id:string;name:string;parentId:string|null}>;
  metadataOnly: boolean;
}
export interface AssetAISearch {
  matches: Array<{id:string;filename:string;description:string;score:number}>;
  examined: number;
  nextAfter: string | null;
  metadataOnly: boolean;
}
