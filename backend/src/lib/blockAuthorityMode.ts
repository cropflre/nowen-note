export type BlockAuthorityMode = "shadow" | "primary";

export interface BlockAuthorityReadResult {
  content: string;
  source: "blocks" | "notes";
  status: "healthy" | "missing" | "mismatch";
  shouldRepair?: true;
}

export function resolveBlockAuthorityMode(
  value = process.env.NOWEN_BLOCK_AUTHORITY_MODE,
): BlockAuthorityMode {
  return value === "primary" ? "primary" : "shadow";
}

export function selectBlockAuthorityRead(
  mode: BlockAuthorityMode,
  authority: Omit<BlockAuthorityReadResult, "shouldRepair">,
  notesContent: string,
): BlockAuthorityReadResult {
  const selected = mode === "primary" && authority.status === "healthy"
    ? authority
    : {
        content: notesContent,
        source: "notes" as const,
        status: authority.status,
      };
  return authority.status === "missing"
    ? { ...selected, shouldRepair: true }
    : selected;
}
