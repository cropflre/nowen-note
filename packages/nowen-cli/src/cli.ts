#!/usr/bin/env node
/**
 * nowen-cli — Nowen Note 命令行工具
 *
 * 用法：
 *   nowen notes list              列出笔记
 *   nowen notes get <id>          查看笔记
 *   nowen notes create            创建笔记
 *   nowen notebooks list          列出笔记本
 *   nowen search <query>          搜索笔记
 *   nowen tasks list              列出任务
 *   nowen tags list               列出标签
 *   nowen ai ask <question>       知识库问答
 *   nowen ai process              AI 文本处理
 *   nowen config                  配置连接信息
 *
 * 环境变量：
 *   NOWEN_URL       Nowen Note 后端地址（默认 http://localhost:3001）
 *   NOWEN_USERNAME  登录用户名（默认 admin）
 *   NOWEN_PASSWORD  登录密码（默认 admin123）
 */

import { Command } from "commander";
import chalk from "chalk";
import { NowenClient } from "./sdk-client.js";
import { registerNotesCommands } from "./commands/notes.js";
import { registerNotebooksCommands } from "./commands/notebooks.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerTasksCommands } from "./commands/tasks.js";
import { registerTagsCommands } from "./commands/tags.js";
import { registerAICommands } from "./commands/ai.js";
import { registerConfigCommand } from "./commands/config.js";

// ===== 读取配置 =====
export function getClient(): NowenClient {
  return new NowenClient({
    baseUrl: process.env.NOWEN_URL || "http://localhost:3001",
    username: process.env.NOWEN_USERNAME || "admin",
    password: process.env.NOWEN_PASSWORD || "admin123",
  });
}

// ===== 主程序 =====
const program = new Command();

program
  .name("nowen")
  .description(chalk.bold("Nowen Note 命令行工具") + " — 从终端管理你的笔记")
  .version("1.0.0");

registerNotesCommands(program);
registerNotebooksCommands(program);
registerSearchCommand(program);
registerTasksCommands(program);
registerTagsCommands(program);
registerAICommands(program);
registerConfigCommand(program);

program.parse();
