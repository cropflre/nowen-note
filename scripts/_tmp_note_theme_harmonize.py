from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"expected block not found in {path}: {old[:120]!r}")
    if text.count(old) != 1:
        raise SystemExit(f"expected block not unique in {path}: {text.count(old)}")
    file.write_text(text.replace(old, new, 1))


old_tokens = '''export interface PluginNoteThemeTokens {
  canvasBackground?: string;
  contentBackground?: string;
  text?: string;
  mutedText?: string;
  headingText?: string;
  link?: string;
  accent?: string;
  border?: string;
  quoteBackground?: string;
  quoteBorder?: string;
  tableBorder?: string;
  tableHeaderBackground?: string;
  codeBackground?: string;
  codeText?: string;
  inlineCodeBackground?: string;
  selection?: string;
  contentMaxWidth?: number;
  fontCategory?: PluginNoteThemeFontCategory;
  fontSize?: number;
  lineHeight?: number;
  paragraphSpacing?: number;
  h1FontSize?: number;
  h2FontSize?: number;
  h3FontSize?: number;
  contentPadding?: number;
}'''
new_tokens = '''export interface PluginNoteThemeTokens {
  canvasBackground?: string;
  contentBackground?: string;
  contentText?: string;
  mutedText?: string;
  headingText?: string;
  linkColor?: string;
  linkWeight?: number;
  quoteBackground?: string;
  quoteBorder?: string;
  tableBorder?: string;
  tableHeaderBackground?: string;
  tableStripeBackground?: string;
  codeBackground?: string;
  inlineCodeBackground?: string;
  contentMaxWidth?: number;
  contentPaddingInline?: number;
  contentPaddingBlock?: number;
  fontCategory?: PluginNoteThemeFontCategory;
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
  paragraphSpacing?: number;
  radius?: number;
  controlBackground?: string;
  controlBorder?: string;
}'''
replace_once("backend/src/plugins/types.ts", old_tokens, new_tokens)

old_front = '''export interface PluginNoteThemeTokens {
  canvasBackground?: string; contentBackground?: string; text?: string; mutedText?: string; headingText?: string;
  link?: string; accent?: string; border?: string; quoteBackground?: string; quoteBorder?: string;
  tableBorder?: string; tableHeaderBackground?: string; codeBackground?: string; codeText?: string;
  inlineCodeBackground?: string; selection?: string; contentMaxWidth?: number; fontCategory?: PluginNoteThemeFontCategory;
  fontSize?: number; lineHeight?: number; paragraphSpacing?: number; h1FontSize?: number; h2FontSize?: number;
  h3FontSize?: number; contentPadding?: number;
}'''
new_front = '''export interface PluginNoteThemeTokens {
  canvasBackground?: string; contentBackground?: string; contentText?: string; mutedText?: string; headingText?: string;
  linkColor?: string; linkWeight?: number; quoteBackground?: string; quoteBorder?: string; tableBorder?: string;
  tableHeaderBackground?: string; tableStripeBackground?: string; codeBackground?: string; inlineCodeBackground?: string;
  contentMaxWidth?: number; contentPaddingInline?: number; contentPaddingBlock?: number; fontCategory?: PluginNoteThemeFontCategory;
  fontSize?: number; lineHeight?: number; letterSpacing?: number; paragraphSpacing?: number; radius?: number;
  controlBackground?: string; controlBorder?: string;
}'''
replace_once("frontend/src/lib/pluginApi.ts", old_front, new_front)

old_schema = '''const noteThemeTokensSchema = z.object({
  canvasBackground: noteThemeColorSchema.optional(), contentBackground: noteThemeColorSchema.optional(),
  text: noteThemeColorSchema.optional(), mutedText: noteThemeColorSchema.optional(), headingText: noteThemeColorSchema.optional(),
  link: noteThemeColorSchema.optional(), accent: noteThemeColorSchema.optional(), border: noteThemeColorSchema.optional(),
  quoteBackground: noteThemeColorSchema.optional(), quoteBorder: noteThemeColorSchema.optional(),
  tableBorder: noteThemeColorSchema.optional(), tableHeaderBackground: noteThemeColorSchema.optional(),
  codeBackground: noteThemeColorSchema.optional(), codeText: noteThemeColorSchema.optional(),
  inlineCodeBackground: noteThemeColorSchema.optional(), selection: noteThemeColorSchema.optional(),
  contentMaxWidth: z.number().int().min(480).max(1200).optional(),
  fontCategory: z.enum(["system", "sans", "serif", "mono"]).optional(),
  fontSize: z.number().min(12).max(24).optional(), lineHeight: z.number().min(1.2).max(2.2).optional(),
  paragraphSpacing: z.number().min(0).max(32).optional(), h1FontSize: z.number().min(24).max(56).optional(),
  h2FontSize: z.number().min(20).max(44).optional(), h3FontSize: z.number().min(18).max(36).optional(),
  contentPadding: z.number().min(12).max(96).optional(),
}).strict().superRefine((tokens, ctx) => {
  if (Object.keys(tokens).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Note Theme token 不能为空" });
});'''
new_schema = '''const noteThemeTokensSchema = z.object({
  canvasBackground: noteThemeColorSchema.optional(), contentBackground: noteThemeColorSchema.optional(),
  contentText: noteThemeColorSchema.optional(), mutedText: noteThemeColorSchema.optional(), headingText: noteThemeColorSchema.optional(),
  linkColor: noteThemeColorSchema.optional(), linkWeight: z.number().int().min(400).max(700).optional(),
  quoteBackground: noteThemeColorSchema.optional(), quoteBorder: noteThemeColorSchema.optional(),
  tableBorder: noteThemeColorSchema.optional(), tableHeaderBackground: noteThemeColorSchema.optional(), tableStripeBackground: noteThemeColorSchema.optional(),
  codeBackground: noteThemeColorSchema.optional(), inlineCodeBackground: noteThemeColorSchema.optional(),
  contentMaxWidth: z.number().int().min(480).max(1200).optional(),
  contentPaddingInline: z.number().min(16).max(96).optional(), contentPaddingBlock: z.number().min(16).max(120).optional(),
  fontCategory: z.enum(["system", "sans", "serif", "mono"]).optional(),
  fontSize: z.number().min(12).max(24).optional(), lineHeight: z.number().min(1.2).max(2.2).optional(),
  letterSpacing: z.number().min(-0.5).max(2).optional(), paragraphSpacing: z.number().min(0).max(32).optional(),
  radius: z.number().min(0).max(24).optional(), controlBackground: noteThemeColorSchema.optional(), controlBorder: noteThemeColorSchema.optional(),
}).strict().superRefine((tokens, ctx) => {
  if (Object.keys(tokens).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Note Theme token 不能为空" });
});'''
replace_once("backend/src/plugins/manifest.ts", old_schema, new_schema)

marker = '''export const pluginManifestV2Schema = z.union([executableV2Schema, declarativeV2Schema]).superRefine((manifest, ctx) => {
  if (!manifest.id.startsWith(`${manifest.publisher}.`)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "插件 ID 必须位于 Publisher namespace" });'''
replacement = '''export const pluginManifestV2Schema = z.union([executableV2Schema, declarativeV2Schema]).superRefine((manifest, ctx) => {
  if (!manifest.id.startsWith(`${manifest.publisher}.`)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "插件 ID 必须位于 Publisher namespace" });
  const noteThemeIds = (manifest.contributes?.noteThemes || []).map((theme) => theme.id);
  if (new Set(noteThemeIds).size !== noteThemeIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contributes", "noteThemes"], message: "Note Theme id 不能重复" });'''
replace_once("backend/src/plugins/manifest.ts", marker, replacement)
