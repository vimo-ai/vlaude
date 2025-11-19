import chalk from 'chalk';
import type { ClaudeStatusJSON, VlaudeStatus } from './types';
import { getModelMaxTokens } from './context';
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
  contextLength: number | null,
  tokenMetrics: TokenMetrics | null,
  gitChanges: GitChanges | null
): string {
  const parts: string[] = [];

  // 1. Vlaude 连接状态
  if (vlaudeStatus.connected) {
    if (vlaudeStatus.mode === 'remote') {
      parts.push(chalk.yellow('📱'));
    } else {
      parts.push(chalk.green('✅'));
    }
  } else {
    parts.push(chalk.red('❌'));
  }

  // 2. Context 进度条
  if (contextLength !== null) {
    const maxTokens = getModelMaxTokens(data.model?.id);
    const percentage = Math.min(100, (contextLength / maxTokens) * 100);
    parts.push(renderProgressBar(percentage) + ' ' + chalk.gray(`${percentage.toFixed(1)}%`));
  }

  // 3. Token 使用情况
  if (tokenMetrics) {
    parts.push(
      chalk.blue(`↑ ${formatTokens(tokenMetrics.inputTokens)}`) +
      ' ' +
      chalk.cyan(`↓ ${formatTokens(tokenMetrics.outputTokens)}`)
    );
  }

  // 4. Git 变更
  if (gitChanges) {
    parts.push(chalk.yellow(`(+${gitChanges.insertions},-${gitChanges.deletions})`));
  }

  // 5. Session ID (短格式)
  if (data.session_id) {
    const shortId = data.session_id.slice(0, 8);
    parts.push(chalk.gray(shortId));
  }

  // 用 | 分隔各部分
  return parts.join(chalk.gray(' | '));
}
