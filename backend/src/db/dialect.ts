/**
 * SQL Dialect Helper
 *
 * 为 SQLite / PostgreSQL 共用 Repository 提供保守的 SQL 规范化。
 * 这里不尝试实现完整 SQL parser，只处理项目内高频且可确定的差异：
 * - ? 参数占位符；
 * - camelCase 标识符引用；
 * - datetime('now')；
 * - INSERT OR IGNORE；
 * - 常见 BOOLEAN 条件中的 0/1。
 */

export type DatabaseDialect = "sqlite" | "postgres";

/** 返回当前时间表达式。 */
export function nowExpression(dialect: DatabaseDialect): string {
  if (dialect === "postgres") return "NOW()";
  return "datetime('now')";
}

/** 返回第 N 个参数占位符。 */
export function placeholder(index: number, dialect: DatabaseDialect): string {
  if (dialect === "postgres") return `$${index}`;
  return "?";
}

type SqlCodeTransform = (code: string) => string;

/**
 * 只转换 SQL 的代码区，跳过字符串、已加双引号的标识符和注释。
 * 这可避免 JSON 文本、LIKE 模式或注释中的 ? 被误当成参数。
 */
function transformSqlCode(sql: string, transform: SqlCodeTransform): string {
  let output = "";
  let code = "";
  let index = 0;

  const flushCode = () => {
    if (!code) return;
    output += transform(code);
    code = "";
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'" || char === '"' || char === "`") {
      flushCode();
      const quote = char;
      output += char;
      index += 1;
      while (index < sql.length) {
        const current = sql[index];
        output += current;
        index += 1;
        if (current !== quote) continue;
        if (sql[index] === quote) {
          output += sql[index];
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      flushCode();
      const lineEnd = sql.indexOf("\n", index);
      if (lineEnd === -1) {
        output += sql.slice(index);
        index = sql.length;
      } else {
        output += sql.slice(index, lineEnd + 1);
        index = lineEnd + 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      flushCode();
      const commentEnd = sql.indexOf("*/", index + 2);
      if (commentEnd === -1) {
        output += sql.slice(index);
        index = sql.length;
      } else {
        output += sql.slice(index, commentEnd + 2);
        index = commentEnd + 2;
      }
      continue;
    }

    code += char;
    index += 1;
  }

  flushCode();
  return output;
}

/** 将 SQL 中代码区的 ? 依次转换为 PostgreSQL 参数。 */
export function convertPlaceholders(sql: string, dialect: DatabaseDialect): string {
  if (dialect === "sqlite") return sql;

  let index = 0;
  return transformSqlCode(sql, (code) => code.replace(/\?/g, () => `$${++index}`));
}

/** PostgreSQL 中未加引号的 camelCase 会被折叠成小写。 */
function quoteCamelCaseIdentifiers(sql: string): string {
  return transformSqlCode(sql, (code) =>
    code.replace(/\b[a-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/g, (identifier) => `"${identifier}"`),
  );
}

function convertNowExpressions(sql: string): string {
  return sql.replace(/datetime\s*\(\s*(['"])now\1\s*\)/gi, "NOW()");
}

function convertBooleanPredicates(sql: string): string {
  const booleanName = "(?:enabled|disabled|is[A-Z][A-Za-z0-9_]*|has[A-Z][A-Za-z0-9_]*|can[A-Z][A-Za-z0-9_]*|must[A-Z][A-Za-z0-9_]*|[A-Za-z0-9_]+Enabled)";
  const identifier = `(?:"${booleanName}"|${booleanName})`;

  return sql
    .replace(new RegExp(`(${identifier})\\s*(=|!=|<>)\\s*([01])\\b`, "g"), (_match, column, operator, value) =>
      `${column} ${operator} ${value === "1" ? "true" : "false"}`,
    )
    .replace(new RegExp(`COALESCE\\(\\s*(${identifier})\\s*,\\s*([01])\\s*\\)`, "gi"), (_match, column, value) =>
      `COALESCE(${column}, ${value === "1" ? "true" : "false"})`,
    );
}

function convertInsertOrIgnore(sql: string): string {
  if (!/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) return sql;

  let converted = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");
  if (/\bON\s+CONFLICT\b/i.test(converted)) return converted;

  const semicolonMatch = /;\s*$/.exec(converted);
  const semicolonIndex = semicolonMatch?.index ?? converted.length;
  const returningMatch = /\bRETURNING\b/i.exec(converted);
  const insertionIndex = returningMatch?.index ?? semicolonIndex;

  converted = `${converted.slice(0, insertionIndex).trimEnd()} ON CONFLICT DO NOTHING ${converted.slice(insertionIndex).trimStart()}`;
  return converted.trimEnd();
}

/**
 * 将项目内的 SQLite 风格 Repository SQL 转换为 PostgreSQL 可执行 SQL。
 * SQLite 路径保持原样，避免改变现有默认部署行为。
 */
export function convertSql(sql: string, dialect: DatabaseDialect): string {
  if (dialect === "sqlite") return sql;

  let converted = convertNowExpressions(sql);
  converted = convertInsertOrIgnore(converted);
  converted = convertBooleanPredicates(converted);
  converted = quoteCamelCaseIdentifiers(converted);
  return convertPlaceholders(converted, dialect);
}

/** 返回适配当前方言的布尔参数值。 */
export function booleanValue(value: boolean, dialect: DatabaseDialect): unknown {
  if (dialect === "postgres") return value;
  return value ? 1 : 0;
}

/** 返回 INSERT 冲突策略。 */
export function conflictDoNothing(dialect: DatabaseDialect): string {
  if (dialect === "postgres") return "ON CONFLICT DO NOTHING";
  return "INSERT OR IGNORE";
}
