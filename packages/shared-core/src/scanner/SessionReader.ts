/**
 * 会话消息读取器
 * 纯函数，不依赖 NestJS
 */
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { parseJsonlContent, parseJsonLine } from '../parser/JsonlParser';
import { isSummaryEntry } from '../parser/MessageFilter';

/**
 * 会话消息读取结果
 */
export interface SessionMessagesResult {
  messages: unknown[];
  total: number;
  hasMore: boolean;
}

/**
 * 读取文件第一行
 */
export async function readFirstLine(filePath: string): Promise<string | null> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    const firstLine = content.split('\n')[0];
    return firstLine?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 快速统计文件行数（非空行）
 */
export async function countFileLines(filePath: string): Promise<number> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    return content.split('\n').filter((line: string) => line.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * 检查会话文件是否为 summary 文件
 * @param sessionPath 会话文件路径
 * @returns 是否为 summary 文件
 */
export async function isSummaryFile(sessionPath: string): Promise<boolean> {
  const lineCount = await countFileLines(sessionPath);
  if (lineCount !== 1) return false;

  const firstLine = await readFirstLine(sessionPath);
  if (!firstLine) return false;

  const entry = parseJsonLine(firstLine);
  return entry !== null && isSummaryEntry(entry as { type?: string });
}

/**
 * 读取指定会话的消息内容（支持分页）
 * @param sessionPath 会话文件完整路径
 * @param limit 每页条数（默认 50）
 * @param offset 偏移量（默认 0）
 * @param order 排序方式：'asc' 正序（旧到新），'desc' 倒序（新到旧），默认 'asc'
 */
export async function readSessionMessages(
  sessionPath: string,
  limit: number = 50,
  offset: number = 0,
  order: 'asc' | 'desc' = 'asc',
): Promise<SessionMessagesResult | null> {
  try {
    await fsPromises.access(sessionPath);
  } catch {
    return null;
  }

  try {
    const content = await fsPromises.readFile(sessionPath, 'utf-8');
    const allMessages = parseJsonlContent(content, true);
    const total = allMessages.length;

    // 根据排序方式处理消息顺序
    const sortedMessages = order === 'desc' ? [...allMessages].reverse() : allMessages;

    // 应用分页
    const messages = sortedMessages.slice(offset, offset + limit);

    return {
      messages,
      total,
      hasMore: offset + messages.length < total,
    };
  } catch {
    return null;
  }
}

/**
 * 构建会话文件路径
 * @param claudeProjectsPath Claude projects 目录路径
 * @param encodedDirName 编码的目录名
 * @param sessionId 会话 ID
 */
export function buildSessionPath(
  claudeProjectsPath: string,
  encodedDirName: string,
  sessionId: string,
): string {
  return path.join(claudeProjectsPath, encodedDirName, `${sessionId}.jsonl`);
}

/**
 * 判断文件名是否为有效的会话文件
 * 有效条件：以 .jsonl 结尾且不以 agent- 开头
 */
export function isValidSessionFile(filename: string): boolean {
  return filename.endsWith('.jsonl') && !filename.startsWith('agent-');
}

/**
 * 从文件名提取 session ID
 */
export function extractSessionId(filename: string): string {
  return filename.replace(/\.jsonl$/, '');
}
