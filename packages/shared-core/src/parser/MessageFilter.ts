/**
 * Claude Code 消息过滤器
 * 用于过滤 SDK 内部消息类型
 */

/**
 * SDK 内部消息类型（应被过滤掉）
 */
export const INTERNAL_MESSAGE_TYPES = [
  'queue-operation',
  'checkpoint',
  'file-history-snapshot',
  'summary',
] as const;

export type InternalMessageType = (typeof INTERNAL_MESSAGE_TYPES)[number];

/**
 * 判断消息是否为内部消息类型
 */
export function isInternalMessage(message: { type?: string }): boolean {
  if (!message.type) return false;
  return INTERNAL_MESSAGE_TYPES.includes(message.type as InternalMessageType);
}

/**
 * 过滤掉内部消息，只保留用户可见消息
 */
export function filterInternalMessages<T extends { type?: string }>(
  messages: T[],
): T[] {
  return messages.filter((msg) => !isInternalMessage(msg));
}

/**
 * 判断 JSONL 文件是否为 summary 文件
 * summary 文件只有一行且 type 为 summary
 */
export function isSummaryEntry(entry: { type?: string }): boolean {
  return entry.type === 'summary';
}
