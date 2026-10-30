import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import ora from "ora";
import { getClient } from "../cli.js";

export function registerNotesCommands(program: Command) {
  const notes = program
    .command("notes")
    .description("笔记管理");

  // nowen notes list
  notes
    .command("list")
    .description("列出笔记")
    .option("-n, --notebook <id>", "按笔记本筛选")
    .option("-t, --tag <id>", "按标签筛选")
    .option("-f, --favorite", "只显示收藏")
    .option("--trashed", "显示回收站")
    .option("-s, --search <query>", "搜索关键词")
    .option("--limit <n>", "显示数量", "20")
    .action(async (opts) => {
      const spinner = ora("加载笔记列表...").start();
      try {
        const client = getClient();
        const query: Record<string, string | undefined> = {};
        if (opts.notebook) query.notebookId = opts.notebook;
        if (opts.tag) query.tagId = opts.tag;
        if (opts.favorite) query.isFavorite = "1";
        if (opts.trashed) query.isTrashed = "1";
        if (opts.search) query.search = opts.search;

        const notes = await client.request("/api/notes", { query });
        spinner.stop();

        if (notes.length === 0) {
          console.log(chalk.yellow("暂无笔记"));
          return;
        }

        const limit = parseInt(opts.limit);
        const table = new Table({
          head: [
            chalk.cyan("ID"),
            chalk.cyan("标题"),
            chalk.cyan("更新时间"),
            chalk.cyan("状态"),
          ],
          colWidths: [10, 30, 20, 12],
        });

        for (const note of notes.slice(0, limit)) {
          const flags = [
            note.isPinned ? "📌" : "",
            note.isFavorite ? "⭐" : "",
            note.isLocked ? "🔒" : "",
          ].filter(Boolean).join("") || "—";

          table.push([
            note.id.slice(0, 8),
            (note.title || "无标题").slice(0, 28),
            new Date(note.updatedAt).toLocaleDateString(),
            flags,
          ]);
        }

        console.log(table.toString());
        console.log(chalk.gray(`共 ${notes.length} 篇笔记`));
      } catch (err: any) {
        spinner.fail(chalk.red(err.message));
      }
    });

  // nowen notes get <id>
  notes
    .command("get <id>")
    .description("查看笔记内容")
    .option("--json", "以 JSON 格式输出")
    .action(async (id, opts) => {
      const spinner = ora("加载笔记...").start();
      try {
        const client = getClient();
        const note = await client.request(`/api/notes/${id}`);
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(note, null, 2));
        } else {
          console.log(chalk.bold.blue(`📝 ${note.title || "无标题"}`));
          console.log(chalk.gray(`ID: ${note.id} | 版本: ${note.version} | 更新: ${note.updatedAt}`));
          if (note.tags?.length) {
            console.log(chalk.gray(`标签: ${note.tags.map((t: any) => `#${t.name}`).join(" ")}`));
          }
          console.log(chalk.gray("─".repeat(50)));
          console.log(note.contentText || "(空)");
        }
      } catch (err: any) {
        spinner.fail(chalk.red(err.message));
      }
    });

  // nowen notes create
  notes
    .command("create")
    .description("创建笔记")
    .requiredOption("-b, --notebook <id>", "笔记本 ID")
    .option("-t, --title <title>", "标题")
    .option("-c, --content <text>", "内容")
    .action(async (opts) => {
      const spinner = ora("创建笔记...").start();
      try {
        const client = getClient();
        const body: any = { notebookId: opts.notebook };
        if (opts.title) body.title = opts.title;
        if (opts.content) {
          body.content = JSON.stringify({
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: opts.content }] }],
          });
          body.contentText = opts.content;
        }
        const note = await client.request("/api/notes", { method: "POST", body });
        spinner.succeed(chalk.green(`笔记创建成功: ${note.title || "无标题"} (${note.id.slice(0, 8)})`));
      } catch (err: any) {
        spinner.fail(chalk.red(err.message));
      }
    });

  // nowen notes update <id>
  notes
    .command("update <id>")
    .description("更新笔记")
    .option("-t, --title <title>", "新标题")
    .option("-c, --content <text>", "新内容")
    .option("--favorite", "设为收藏")
    .option("--unfavorite", "取消收藏")
    .option("--pin", "置顶")
    .option("--unpin", "取消置顶")
    .action(async (id, opts) => {
      const spinner = ora("更新笔记...").start();
      try {
        const client = getClient();
        const body: any = {};
        if (opts.title) body.title = opts.title;
        if (opts.content) {
          body.content = JSON.stringify({
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: opts.content }] }],
          });
          body.contentText = opts.content;
        }
        if (opts.favorite) body.isFavorite = 1;
        if (opts.unfavorite) body.isFavorite = 0;
        if (opts.pin) body.isPinned = 1;
        if (opts.unpin) body.isPinned = 0;

        const note = await client.request(`/api/notes/${id}`, { method: "PUT", body });
        spinner.succeed(chalk.green(`笔记已更新: ${note.title} (v${note.version})`));
      } catch (err: any) {
        spinner.fail(chalk.red(err.message));
      }
    });

  // nowen notes delete <id>
  notes
    .command("delete <id>")
    .description("删除笔记")
    .option("--permanent", "永久删除已在回收站的笔记（默认移入回收站）")
    .action(async (id, opts) => {
      const spinner = ora("删除笔记...").start();
      try {
        const client = getClient();
        if (opts.permanent) {
          await client.request(`/api/notes/${id}/permanent`, { method: "DELETE" });
          spinner.succeed(chalk.green("笔记已永久删除"));
        } else {
          await client.request(`/api/notes/${id}`, { method: "PUT", body: { isTrashed: 1 } });
          spinner.succeed(chalk.green("笔记已移入回收站"));
        }
      } catch (err: any) {
        spinner.fail(chalk.red(err.message));
      }
    });
}
