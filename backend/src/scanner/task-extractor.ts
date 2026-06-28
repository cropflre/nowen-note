/**
 * scanner/task-extractor.ts — 任务提取器
 *
 * 从 Markdown 正文中提取 GFM 任务列表项:
 *   - [ ] 未完成
 *   - [x] 已完成
 *
 * 支持 @high/@medium 优先级和 @YYYY-MM-DD 截止日期。
 */
export interface ExtractedTask {
  /** 任务标题 */
  title: string;
  /** 是否已完成 */
  completed: boolean;
  /** 优先级 (1=high, 2=medium, 3=low) */
  priority: number;
  /** 截止日期 (ISO 8601) */
  dueDate: string | null;
  /** 缩进级别（0 = 顶层） */
  indent: number;
  /** 父任务的标题（缩进时） */
  parentTitle: string | null;
  /** 在正文中的行号（0-based） */
  lineNumber: number;
}

/**
 * 从正文中提取所有 GFM 任务
 */
export function extractTasks(body: string): ExtractedTask[] {
  const tasks: ExtractedTask[] = [];
  const lines = body.split("\n");
  let lastTopLevelTitle: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    // 跳过代码块
    if (trimmed.startsWith("```")) {
      // 找到结束 ```
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().startsWith("```")) {
          i = j;
          break;
        }
      }
      continue;
    }

    // 跟踪最近的标题（用于任务分组的上下文）
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      lastTopLevelTitle = headingMatch[1].trim();
      continue;
    }

    // 匹配 GFM 任务列表
    // 格式: [空格]* [空格]- [空格][ 或 x] [空格]任务文本
    const taskRegex = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)/;
    const taskMatch = trimmed.match(taskRegex);
    if (!taskMatch) continue;

    const indent = Math.floor(taskMatch[1].length / 2); // 2空格=1级缩进
    const isChecked = taskMatch[2].toLowerCase() === "x";
    const taskText = taskMatch[3];

    // 解析优先级标记 @high/@medium/@low
    let priority = 2; // 默认 medium
    const priorityMatch = taskText.match(/@(high|medium|low)\b/i);
    if (priorityMatch) {
      const p = priorityMatch[1].toLowerCase();
      if (p === "high") priority = 1;
      else if (p === "low") priority = 3;
    }

    // 解析截止日期 @YYYY-MM-DD
    let dueDate: string | null = null;
    const dateMatch = taskText.match(/@(\d{4}-\d{2}-\d{2})\b/);
    if (dateMatch) {
      dueDate = dateMatch[1];
    }

    // 清理任务文本（移除 @ 标记）
    const cleanTitle = taskText
      .replace(/@(high|medium|low)\b/gi, "")
      .replace(/@\d{4}-\d{2}-\d{2}\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

    tasks.push({
      title: cleanTitle,
      completed: isChecked,
      priority,
      dueDate,
      indent,
      parentTitle: indent > 0 ? lastTopLevelTitle : null,
      lineNumber: i,
    });
  }

  return tasks;
}
