import * as fs from 'fs';

// 加权系数（以 cache_read = 1 为基准，基于 API 定价近似）
const W_CACHE_READ = 1.0;
const W_CACHE_CREATE = 16.0;
const W_INPUT = 10.0;
const W_OUTPUT = 50.0;

export interface TokenMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // 每轮加权成本
  costMultiplier: number | null;  // ×N 倍率，null 表示数据不足
  lastRoundCost: number;          // 最近一轮的加权成本
  sweetSpotCost: number;          // 甜蜜区基准成本
  roundCount: number;             // 当前轮数
}

function weightedCost(cr: number, cc: number, inp: number, out: number): number {
  return cr * W_CACHE_READ + cc * W_CACHE_CREATE + inp * W_INPUT + out * W_OUTPUT;
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
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;

    // 按 requestId 去重，每个 API 请求只取最后一条（含完整 usage）
    // JSONL 中同一请求会因 thinking/text/tool_use 等 content block 产生多条记录
    const lastByRequest = new Map<string, { cr: number; cc: number; inp: number; out: number }>();
    const requestOrder: string[] = [];

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.message?.usage && data.requestId) {
          const u = data.message.usage;
          const entry = {
            cr: u.cache_read_input_tokens || 0,
            cc: u.cache_creation_input_tokens || 0,
            inp: u.input_tokens || 0,
            out: u.output_tokens || 0,
          };
          if (!lastByRequest.has(data.requestId)) {
            requestOrder.push(data.requestId);
          }
          lastByRequest.set(data.requestId, entry);
        }
      } catch {
        // 跳过无效的 JSON 行
      }
    }

    // 按请求顺序累计 token 并记录每轮 cache_read
    let lastCr = 0;
    let lastRoundCost = 0;
    let roundCount = 0;
    for (const rid of requestOrder) {
      const { cr, cc, inp, out } = lastByRequest.get(rid)!;
      inputTokens += inp;
      outputTokens += out;
      cacheReadTokens += cr;
      cacheWriteTokens += cc;
      lastCr = cr;
      lastRoundCost = weightedCost(cr, cc, inp, out);
      roundCount++;
    }

    // ×N 基于 cache_read 算，去除 cc/output 的单轮波动
    // 公式由 892 session 清洗后统计数据线性拟合：×N = (cr + 61500) / 143000
    // init 阶段 (cr < 20K) 用实际加权成本
    const sweetSpotCost = 113935;
    let costMultiplier: number | null = null;
    if (roundCount > 0) {
      if (lastCr < 20000) {
        // init 阶段，用实际成本
        costMultiplier = lastRoundCost > 0 ? lastRoundCost / sweetSpotCost : null;
      } else {
        costMultiplier = (lastCr + 61500) / 143000;
      }
    }

    return {
      inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
      costMultiplier, lastRoundCost, sweetSpotCost,
      roundCount,
    };
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
