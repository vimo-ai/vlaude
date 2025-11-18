import * as fs from 'fs';

export interface TokenMetrics {
  inputTokens: number;
  outputTokens: number;
}

/**
 * 从 transcript 文件获取 token metrics
 */
export async function getTokenMetrics(transcriptPath?: string): Promise<TokenMetrics | null> {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return null;
  }

  try {
    const content = await fs.promises.readFile(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');

    let inputTokens = 0;
    let outputTokens = 0;

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.message?.usage) {
          inputTokens += data.message.usage.input_tokens || 0;
          outputTokens += data.message.usage.output_tokens || 0;
        }
      } catch {
        // 跳过无效的 JSON 行
      }
    }

    return { inputTokens, outputTokens };
  } catch {
    return null;
  }
}

/**
 * 格式化 token 数量（5500 -> 5.5k）
 */
export function formatTokens(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}
