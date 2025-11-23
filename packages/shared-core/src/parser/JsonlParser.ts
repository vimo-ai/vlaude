/**
 * JSONL 文件解析工具
 */
import { execSync } from 'child_process';
import { filterInternalMessages } from './MessageFilter';

/**
 * 从 JSONL 文件中提取项目路径（使用 grep 命令）
 * @param jsonlFilePath JSONL 文件的完整路径
 * @returns 项目路径，如果未找到返回 null
 */
export function extractProjectPath(jsonlFilePath: string): string | null {
  try {
    // 使用 grep 提取 cwd 字段，读取前 10 行
    const result = execSync(
      `head -n 10 "${jsonlFilePath}" | grep -o '"cwd":"[^"]*"' | head -1`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'], // 忽略 stderr
      },
    ).trim();

    if (result) {
      // 提取引号中的路径：从 "cwd":"/path" 中提取 /path
      const match = result.match(/"cwd":"([^"]+)"/);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  } catch {
    // grep 没找到会返回非 0 退出码，这是正常的
    return null;
  }
}

/**
 * 解析 JSONL 内容为消息数组
 * @param content JSONL 文件内容
 * @param filterInternal 是否过滤内部消息类型，默认 true
 * @returns 解析后的消息数组
 */
export function parseJsonlContent<T = unknown>(
  content: string,
  filterInternal: boolean = true,
): T[] {
  const messages = content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((msg): msg is T => msg !== null);

  if (filterInternal) {
    return filterInternalMessages(messages as Array<T & { type?: string }>) as T[];
  }

  return messages;
}

/**
 * 解析单行 JSON
 * @param line JSON 行
 * @returns 解析结果，失败返回 null
 */
export function parseJsonLine<T = unknown>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}
