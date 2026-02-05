import chalk from 'chalk';
import type { ClaudeStatusJSON, VlaudeStatus } from './types';
import { formatTokens, type TokenMetrics } from './tokens';
import type { GitChanges } from './git';

/**
 * 渲染进度条
 * - 0-15%: 深灰色（低风险区）
 * - 15%+: 绿→黄→红渐变（15%开始绿色，逐渐变黄变红）
 * - 真实 90% 时进度条填满（因为 70-80% 就该 compose 了）
 */
function renderProgressBar(percentage: number, barLength: number = 10): string {
  // 将真实 0-90% 映射到进度条 0-100%，这样 90% 时进度条填满
  const displayPercentage = Math.min(100, (percentage / 90) * 100);
  const filled = Math.round((displayPercentage / 100) * barLength);
  const empty = barLength - filled;

  let filledBar = '';
  for (let i = 0; i < filled; i++) {
    // 计算当前位置在整个进度条中的比例 (0 到 1)
    const position = i / (barLength - 1);

    let r: number, g: number, b: number;

    // 0-15%: 使用深灰色
    if (percentage < 15) {
      r = g = b = 120; // 深灰色
    } else {
      // 15% 以上: 绿→黄→红渐变
      if (position < 0.5) {
        // 前半段：绿色 (0,255,0) → 黄色 (255,255,0)
        const t = position * 2; // 0 到 1
        r = Math.round(255 * t);
        g = 255;
        b = 0;
      } else {
        // 后半段：黄色 (255,255,0) → 红色 (255,0,0)
        const t = (position - 0.5) * 2; // 0 到 1
        r = 255;
        g = Math.round(255 * (1 - t));
        b = 0;
      }
    }

    filledBar += chalk.rgb(r, g, b)('█');
  }

  const emptyBar = chalk.gray('░'.repeat(empty));

  return `${filledBar}${emptyBar}`;
}

/**
 * 渲染完整的状态栏
 */
export function renderStatusLine(
  data: ClaudeStatusJSON,
  vlaudeStatus: VlaudeStatus,
  contextPercentage: number | null,
  tokenMetrics: TokenMetrics | null,
  gitChanges: GitChanges | null
): string {
  const parts: string[] = [];

  // 1. Vlaude 连接状态（只在连上时显示）
  if (vlaudeStatus.connected) {
    if (vlaudeStatus.mode === 'remote') {
      parts.push(chalk.yellow('📱'));
    } else {
      parts.push(chalk.green('✅'));
    }
  }
  // 没连上就不显示任何符号

  // 2. Context 进度条
  if (contextPercentage !== null) {
    const percentage = Math.min(100, contextPercentage);
    parts.push(renderProgressBar(percentage) + ' ' + chalk.gray(`${percentage.toFixed(1)}%`));
  }

  // 3. Token 使用情况
  if (tokenMetrics) {
    const tokenParts = [
      chalk.blue(`↑${formatTokens(tokenMetrics.inputTokens)}`),
      chalk.cyan(`↓${formatTokens(tokenMetrics.outputTokens)}`)
    ];
    // Cache tokens - 按健康度变色
    if (tokenMetrics.cacheReadTokens > 0 || tokenMetrics.cacheWriteTokens > 0) {
      // Cache Read: <10M 绿, 10-50M 黄, >50M 红
      const rValue = formatTokens(tokenMetrics.cacheReadTokens);
      let rColor;
      if (tokenMetrics.cacheReadTokens < 10_000_000) {
        rColor = chalk.green;
      } else if (tokenMetrics.cacheReadTokens < 50_000_000) {
        rColor = chalk.yellow;
      } else {
        rColor = chalk.red;
      }
      tokenParts.push(rColor(`R${rValue}`));

      // Cache Write: <1M 绿, 1-5M 黄, >5M 红
      const wValue = formatTokens(tokenMetrics.cacheWriteTokens);
      let wColor;
      if (tokenMetrics.cacheWriteTokens < 1_000_000) {
        wColor = chalk.green;
      } else if (tokenMetrics.cacheWriteTokens < 5_000_000) {
        wColor = chalk.yellow;
      } else {
        wColor = chalk.red;
      }
      tokenParts.push(wColor(`W${wValue}`));

      // 千分比估算: (cacheRead + cacheWrite) / 2.5M = ‰
      // 基于分析: 25M tokens ≈ 1%, 所以 2.5M ≈ 1‰
      const TOKENS_PER_PERMILLE = 2_500_000;
      const totalCache = tokenMetrics.cacheReadTokens + tokenMetrics.cacheWriteTokens;
      const permille = totalCache / TOKENS_PER_PERMILLE;
      const permilleStr = permille < 10 ? permille.toFixed(1) : Math.round(permille).toString();

      // 健康度: <5‰ 绿, 5-20‰ 黄, >20‰ 红
      let permilleColor;
      if (permille < 5) {
        permilleColor = chalk.green;
      } else if (permille < 20) {
        permilleColor = chalk.yellow;
      } else {
        permilleColor = chalk.red;
      }
      tokenParts.push(permilleColor(`~${permilleStr}‰`));
    }
    parts.push(tokenParts.join(' '));
  }

  // 4. Git 变更
  if (gitChanges) {
    parts.push(chalk.yellow(`(+${gitChanges.insertions},-${gitChanges.deletions})`));
  }

  // 5. Session ID
  if (data.session_id) {
    parts.push(chalk.gray(data.session_id));
  }

  // 用 | 分隔各部分
  return parts.join(chalk.gray(' | '));
}
