import chalk from 'chalk';
import type { ClaudeStatusJSON, VlaudeStatus } from './types';
import { getModelMaxTokens } from './context';
import { formatTokens, type TokenMetrics } from './tokens';
import type { GitChanges } from './git';

/**
 * 渲染进度条（带渐变炫光效果）
 */
function renderProgressBar(percentage: number, barLength: number = 10): string {
  const filled = Math.round((percentage / 100) * barLength);
  const empty = barLength - filled;

  // 根据百分比决定主色调和 RGB 值
  let rgb: [number, number, number];
  if (percentage >= 80) {
    rgb = [255, 0, 0]; // 红色
  } else if (percentage >= 60) {
    rgb = [255, 255, 0]; // 黄色
  } else {
    rgb = [0, 255, 0]; // 绿色
  }

  // 创建渐变效果的进度条 - 从左到右逐渐变亮
  let filledBar = '';
  for (let i = 0; i < filled; i++) {
    // 计算亮度因子（0.6 到 1.0）
    const brightnessFactor = 0.6 + (i / filled) * 0.4;

    const r = Math.round(rgb[0] * brightnessFactor);
    const g = Math.round(rgb[1] * brightnessFactor);
    const b = Math.round(rgb[2] * brightnessFactor);

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
    parts.push(renderProgressBar(percentage));
  }

  // 3. Token 使用情况
  if (tokenMetrics) {
    parts.push(
      chalk.blue(`In: ${formatTokens(tokenMetrics.inputTokens)}`) +
      chalk.gray(' | ') +
      chalk.cyan(`Out: ${formatTokens(tokenMetrics.outputTokens)}`)
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
