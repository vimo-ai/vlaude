import * as fs from 'fs';

/**
 * 从 transcript 文件获取 context length
 */
export async function getContextLength(transcriptPath?: string): Promise<number | null> {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return null;
  }

  try {
    const content = await fs.promises.readFile(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');

    let mostRecentMainChainEntry: any = null;
    let mostRecentTimestamp: Date | null = null;

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.message?.usage) {
          // 跟踪最近的 main chain 消息（不是 sidechain）
          if (data.isSidechain !== true && data.timestamp && !data.isApiErrorMessage) {
            const entryTime = new Date(data.timestamp);
            if (!mostRecentTimestamp || entryTime > mostRecentTimestamp) {
              mostRecentTimestamp = entryTime;
              mostRecentMainChainEntry = data;
            }
          }
        }
      } catch {
        // 跳过无效的 JSON 行
      }
    }

    // 从最近的 main chain 消息计算 context length
    if (mostRecentMainChainEntry?.message?.usage) {
      const usage = mostRecentMainChainEntry.message.usage;
      return (usage.input_tokens || 0)
        + (usage.cache_read_input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 获取模型的最大 token 数
 */
export function getModelMaxTokens(modelId?: string): number {
  if (!modelId) return 200000;

  // Claude 4.5 系列
  if (modelId.includes('claude-sonnet-4-5')) return 200000;
  if (modelId.includes('claude-opus-4')) return 200000;

  // Claude 3.5 系列
  if (modelId.includes('claude-3-5-sonnet')) return 200000;
  if (modelId.includes('claude-3-5-haiku')) return 200000;

  // Claude 3 系列
  if (modelId.includes('claude-3-opus')) return 200000;
  if (modelId.includes('claude-3-sonnet')) return 200000;
  if (modelId.includes('claude-3-haiku')) return 200000;

  // 默认值
  return 200000;
}
