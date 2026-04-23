import chalk from 'chalk';
import type { ClaudeStatusJSON, VlaudeStatus } from './types';
import type { TokenMetrics } from './tokens';
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

  // 3. 效率倍率 ×N
  if (tokenMetrics?.costMultiplier !== null && tokenMetrics?.costMultiplier !== undefined) {
    const x = tokenMetrics.costMultiplier;
    const xStr = `×${x < 10 ? x.toFixed(1) : Math.round(x).toString()}`;

    // 颜色：灰(冷启动) → 绿(甜蜜区) → 黄(快出了) → 红(贵了) → 深红(很贵)
    let xColor;
    if (tokenMetrics.roundCount <= 5 && x > 1.3) {
      xColor = chalk.gray;
    } else if (x <= 1.2) {
      xColor = chalk.green;
    } else if (x <= 1.5) {
      xColor = chalk.yellow;
    } else if (x <= 2.0) {
      xColor = chalk.red;
    } else {
      xColor = chalk.rgb(180, 0, 0);
    }
    parts.push(xColor(xStr));
  }

  // 4. Session ID
  if (data.session_id) {
    parts.push(chalk.gray(data.session_id));
  }

  // 5. Git 变更
  if (gitChanges) {
    parts.push(chalk.yellow(`(+${gitChanges.insertions},-${gitChanges.deletions})`));
  }

  // 用 | 分隔各部分
  return parts.join(chalk.gray(' | '));
}
