import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ClaudeStatusJSON, VlaudeStatus } from './types';
import type { TokenMetrics } from './tokens';
import type { GitChanges } from './git';

/**
 * 加权冲刺预测 — 与面板 SprintPredictor 同算法
 * 读取 usage_history.json，取当前 cycle 最近 5 个变化区间，加权平均
 */
function weightedSprintDelta(remaining: number, remainingMs: number): number | null {
  const historyPath = join(process.env.HOME || '', '.vimo/eterm/plugins/claude-monitor/usage_history.json');
  if (!existsSync(historyPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(historyPath, 'utf-8')) as Array<{
      timestamp: string; utilization: number; cycleId: string;
    }>;

    if (raw.length < 2) return null;

    const currentCycleId = raw[raw.length - 1].cycleId;
    const points = raw
      .filter(p => p.cycleId === currentCycleId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (points.length < 2) return null;

    // 提取用量增加的区间
    const intervals: Array<{ timePerPercent: number; ts: number }> = [];
    for (let i = 1; i < points.length; i++) {
      const pctChange = points[i].utilization - points[i - 1].utilization;
      if (pctChange <= 0) continue;
      const duration = new Date(points[i].timestamp).getTime() - new Date(points[i - 1].timestamp).getTime();
      if (duration < 60_000) continue;
      intervals.push({ timePerPercent: duration / pctChange, ts: new Date(points[i].timestamp).getTime() });
    }

    if (intervals.length === 0) return null;

    // 最近的在前，取 5 个
    intervals.sort((a, b) => b.ts - a.ts);
    const recent = intervals.slice(0, 5);

    // 加权平均 (0.40, 0.25, 0.20, 0.10, 0.05)
    const weights = [0.40, 0.25, 0.20, 0.10, 0.05];
    let weightedTpp = 0;
    let totalWeight = 0;
    for (let i = 0; i < recent.length; i++) {
      const w = i < weights.length ? weights[i] : 0.05;
      weightedTpp += recent[i].timePerPercent * w;
      totalWeight += w;
    }
    weightedTpp /= totalWeight;

    const predictFinishMs = weightedTpp * remaining;
    return remainingMs - predictFinishMs;
  } catch {
    return null;
  }
}

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

  // 6. 7天用量：余量 + 剩余时间 + 预计速率（与面板 SprintPredictor 同逻辑）
  if (data.rate_limits?.seven_day) {
    const sd = data.rate_limits.seven_day;
    const resetMs = sd.resets_at * 1000;
    const startMs = resetMs - 7 * 24 * 3600 * 1000;
    const now = Date.now();

    const usageProgress = sd.used_percentage / 100;
    const timeProgress = Math.min(1, Math.max(0, (now - startMs) / (resetMs - startMs)));
    const remaining = Math.max(0, 100 - sd.used_percentage);
    const remainingMs = Math.max(0, resetMs - now);

    // 加权冲刺预测（与面板 SprintPredictor 同算法）
    let sprintStr = '';
    const sprintDeltaMs = weightedSprintDelta(remaining, remainingMs);
    if (sprintDeltaMs !== null) {
      const deltaHours = sprintDeltaMs / 3600000;
      const sign = deltaHours >= 0 ? '+' : '-';
      const absH = Math.abs(deltaHours);
      const hStr = absH >= 1 ? `${Math.floor(absH)}h` : `${Math.round(absH * 60)}m`;
      const color = deltaHours > 2 ? chalk.green : deltaHours < -2 ? chalk.red : chalk.yellow;
      sprintStr = color(` ${sign}${hStr}`);
    }

    // 颜色与面板一致：领先→蓝/绿，落后→黄/红
    const delta = usageProgress - timeProgress;
    let color;
    if (delta >= 0.10) color = chalk.cyan;
    else if (delta >= 0) color = chalk.green;
    else if (delta >= -0.10) color = chalk.yellow;
    else color = chalk.red;

    const hoursLeft = remainingMs / 3600000;
    const timeStr = hoursLeft >= 24
      ? `${Math.floor(hoursLeft / 24)}d${Math.floor(hoursLeft % 24)}h`
      : `${Math.floor(hoursLeft)}h`;

    parts.push(color(`余${remaining.toFixed(0)}%`) + chalk.gray(` ${timeStr}`) + sprintStr);

    // 速度指示：基于 token 公式 (1% ≈ output×5 + cache_write×1.25 ≈ 2190K)
    const COST_PER_PCT = 2_190_000;
    const awakeMs = Math.max(0, remainingMs - 6 * 3600000);
    const targetMinPerPct = remaining > 0 ? awakeMs / 60000 / remaining : 0;

    if (tokenMetrics && tokenMetrics.roundCount >= 2 && targetMinPerPct > 0) {
      const sessionCost = tokenMetrics.outputTokens * 5 + tokenMetrics.cacheWriteTokens * 1.25;
      const sessionPct = sessionCost / COST_PER_PCT;

      if (sessionPct > 0.1) {
        // 从 rate_limits 的变化推算会话时长
        // 用 usage_history 里的时间间隔做 fallback
        const sprintDeltaRaw = weightedSprintDelta(remaining, remainingMs);
        if (sprintDeltaRaw !== null) {
          const predictFinishMs = remainingMs - sprintDeltaRaw;
          const currentMinPerPct = remaining > 0 ? predictFinishMs / 60000 / remaining : 0;
          const arrow = currentMinPerPct <= targetMinPerPct * 0.8 ? '▲' :
                        currentMinPerPct >= targetMinPerPct * 1.2 ? '▼' : '≈';
          const arrowColor = arrow === '▲' ? chalk.green :
                             arrow === '▼' ? chalk.red : chalk.yellow;
          parts.push(chalk.white(`${Math.round(currentMinPerPct)}'`) + arrowColor(arrow) + chalk.gray(`${Math.round(targetMinPerPct)}'`));
        }

        // 显示本会话消耗的估算 %
        parts.push(chalk.gray(`~${sessionPct.toFixed(1)}%`));
      }
    } else {
      // token 数据不足时 fallback 到纯时间间隔
      const sprintDeltaRaw = weightedSprintDelta(remaining, remainingMs);
      if (sprintDeltaRaw !== null && targetMinPerPct > 0) {
        const predictFinishMs = remainingMs - sprintDeltaRaw;
        const currentMinPerPct = remaining > 0 ? predictFinishMs / 60000 / remaining : 0;
        const arrow = currentMinPerPct <= targetMinPerPct * 0.8 ? '▲' :
                      currentMinPerPct >= targetMinPerPct * 1.2 ? '▼' : '≈';
        const arrowColor = arrow === '▲' ? chalk.green :
                           arrow === '▼' ? chalk.red : chalk.yellow;
        parts.push(chalk.white(`${Math.round(currentMinPerPct)}'`) + arrowColor(arrow) + chalk.gray(`${Math.round(targetMinPerPct)}'`));
      }
    }
  }

  // 用 | 分隔各部分
  return parts.join(chalk.gray(' | '));
}
