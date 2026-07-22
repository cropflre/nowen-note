import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import { getAttachmentClient } from "../cli.js";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export function registerAttachmentCommands(program: Command) {
  const attachments = program
    .command("attachments")
    .alias("files")
    .description("附件上传、查询和笔记关联");

  attachments
    .command("upload <file>")
    .description("上传本地文件；传 --note 时直接绑定指定笔记")
    .option("-n, --note <id>", "目标笔记 ID")
    .option("--name <filename>", "上传后使用的文件名")
    .option("--mime <type>", "MIME 类型")
    .option("-w, --workspace <id>", "工作区 ID（仅未绑定上传时使用）")
    .option("-f, --folder <id>", "附件文件夹 ID（仅未绑定上传时使用）")
    .option("--json", "输出完整 JSON")
    .action(async (file, opts) => {
      const spinner = ora("上传附件...").start();
      try {
        const result = await getAttachmentClient().upload({
          filePath: file,
          noteId: opts.note,
          filename: opts.name,
          mimeType: opts.mime,
          workspaceId: opts.workspace,
          folderId: opts.folder,
        });
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const markdown = result.category === "image"
          ? `![${result.filename}](${result.url})`
          : `[${result.filename}](${result.url}?download=1)`;
        console.log(chalk.green(`附件上传成功：${result.filename}`));
        console.log(chalk.gray(`ID: ${result.id}`));
        console.log(chalk.gray(`类型: ${result.mimeType} · 大小: ${formatBytes(result.size)}`));
        console.log(markdown);
      } catch (error: any) {
        spinner.fail(chalk.red(error.message));
      }
    });

  attachments
    .command("list")
    .description("列出文件管理中的附件")
    .option("-c, --category <type>", "all / image / file", "all")
    .option("--filter <type>", "unreferenced / myUploads")
    .option("--reference <type>", "referenced / unreferenced（仅 myUploads）")
    .option("--mime <type>", "精确 MIME 类型")
    .option("-n, --note <id>", "只显示指定笔记引用过的附件")
    .option("-b, --notebook <id>", "按笔记本筛选")
    .option("-f, --folder <id>", "按附件文件夹筛选；__unarchived 表示未归档")
    .option("-q, --query <text>", "文件名关键词")
    .option("--sort <mode>", "created_desc / created_asc / name_asc / name_desc / size_asc / size_desc", "created_desc")
    .option("--page <n>", "页码", "1")
    .option("--page-size <n>", "每页数量，最大 200", "50")
    .option("-w, --workspace <id>", "工作区 ID")
    .option("--json", "输出完整 JSON")
    .action(async (opts) => {
      const spinner = ora("加载附件列表...").start();
      try {
        const category = ["all", "image", "file"].includes(opts.category) ? opts.category : "all";
        const filter = ["unreferenced", "myUploads"].includes(opts.filter) ? opts.filter : undefined;
        const myUploadsRef = ["referenced", "unreferenced"].includes(opts.reference) ? opts.reference : undefined;
        const result = await getAttachmentClient().list({
          category,
          filter,
          myUploadsRef,
          mime: opts.mime,
          noteId: opts.note,
          notebookId: opts.notebook,
          folderId: opts.folder,
          q: opts.query,
          sort: opts.sort,
          page: Math.max(1, Number.parseInt(opts.page, 10) || 1),
          pageSize: Math.min(200, Math.max(1, Number.parseInt(opts.pageSize, 10) || 50)),
          workspaceId: opts.workspace,
        });
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result.items.length) {
          console.log(chalk.yellow("暂无附件"));
          return;
        }

        const table = new Table({
          head: [
            chalk.cyan("ID"),
            chalk.cyan("文件名"),
            chalk.cyan("类型"),
            chalk.cyan("大小"),
            chalk.cyan("归属笔记"),
          ],
          colWidths: [10, 32, 18, 11, 24],
          wordWrap: true,
        });
        for (const item of result.items) {
          table.push([
            String(item.id || "").slice(0, 8),
            item.filename || "—",
            item.mimeType || item.category || "—",
            formatBytes(Number(item.size) || 0),
            item.primaryNote?.title || "未绑定",
          ]);
        }
        console.log(table.toString());
        console.log(chalk.gray(`第 ${result.page} 页，共 ${result.total} 个附件`));
      } catch (error: any) {
        spinner.fail(chalk.red(error.message));
      }
    });

  attachments
    .command("attach <attachmentId> <noteId>")
    .description("把已上传附件插入 Markdown 笔记")
    .option("--alt <text>", "图片 alt 或文件链接标题")
    .option("--mode <mode>", "append / prepend / replace_marker", "append")
    .option("--marker <text>", "replace_marker 模式要替换的占位文本")
    .option("--json", "输出完整 JSON")
    .action(async (attachmentId, noteId, opts) => {
      const spinner = ora("关联附件到笔记...").start();
      try {
        const mode = ["append", "prepend", "replace_marker"].includes(opts.mode) ? opts.mode : "append";
        const note = await getAttachmentClient().attach({
          attachmentId,
          noteId,
          alt: opts.alt,
          mode,
          marker: opts.marker,
        });
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify(note, null, 2));
          return;
        }
        console.log(chalk.green(`附件已插入笔记：${note.title || note.id}`));
        console.log(chalk.gray(`笔记版本: ${note.version}`));
      } catch (error: any) {
        spinner.fail(chalk.red(error.message));
      }
    });
}
