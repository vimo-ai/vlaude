#!/usr/bin/env node

import chalk from 'chalk';
import { readStdin } from './statusline/input';
import { getVlaudeStatus } from './statusline/vlaude-client';
import { getContextLength, getModelMaxTokens } from './statusline/context';
import { getTokenMetrics } from './statusline/tokens';
import { getGitChanges } from './statusline/git';
import { renderStatusLine } from './statusline/renderer';
import type { ClaudeStatusJSON } from './statusline/types';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// 设置 chalk 颜色级别为 24-bit (truecolor)
chalk.level = 3;

/**
 * 检测 session 切换（内部 /resume 命令）
 *
 * 工作原理：
 * 1. 读取上次的 sessionId（从 .vlaude/last-session-id）
 * 2. 对比当前 sessionId（Claude Code 通过 stdin 传递）
 * 3. 如果不同，写入切换信号文件（.vlaude/session-switch.signal）
 * 4. CLI 监听信号文件，响应 session 切换
 */
function detectSessionSwitch(currentSessionId: string | undefined) {
  if (!currentSessionId) return;

  const vlaudeDir = join(process.cwd(), '.vlaude');
  const lastSessionFile = join(vlaudeDir, 'last-session-id');
  const signalFile = join(vlaudeDir, 'session-switch.signal');

  // 确保 .vlaude 目录存在
  if (!existsSync(vlaudeDir)) {
    mkdirSync(vlaudeDir, { recursive: true });
  }

  // 读取上次的 sessionId
  let lastSessionId: string | null = null;
  if (existsSync(lastSessionFile)) {
    try {
      lastSessionId = readFileSync(lastSessionFile, 'utf-8').trim();
    } catch (err) {
      // 文件读取失败，忽略
    }
  }

  // 检测切换
  if (lastSessionId && lastSessionId !== currentSessionId) {
    // Session 切换了！写入信号文件
    try {
      writeFileSync(signalFile, JSON.stringify({
        previousSessionId: lastSessionId,
        currentSessionId: currentSessionId,
        timestamp: Date.now()
      }), 'utf-8');
    } catch (err) {
      // 写入失败，忽略
    }
  }

  // 更新 last-session-id
  try {
    writeFileSync(lastSessionFile, currentSessionId, 'utf-8');
  } catch (err) {
    // 写入失败，忽略
  }
}

/**
 * 持久化 rate_limits 到 ~/.vimo/rate-limits.json
 * ClaudeMonitorKit 读取此文件替代调用 /api/oauth/usage
 */
function persistRateLimits(data: ClaudeStatusJSON) {
  if (!data.rate_limits?.seven_day) return;

  const vimoDir = join(process.env.HOME || '', '.vimo');
  const rateLimitsFile = join(vimoDir, 'rate-limits.json');

  try {
    if (!existsSync(vimoDir)) {
      mkdirSync(vimoDir, { recursive: true });
    }

    const newSevenDay = Math.round(data.rate_limits.seven_day.used_percentage);
    const newFiveHour = data.rate_limits.five_hour
      ? Math.round(data.rate_limits.five_hour.used_percentage) : null;

    if (existsSync(rateLimitsFile)) {
      const old = JSON.parse(readFileSync(rateLimitsFile, 'utf-8'));
      if (old.sevenDay?.utilization === newSevenDay
        && (old.fiveHour?.utilization ?? null) === newFiveHour) {
        return;
      }
    }

    const payload = {
      fiveHour: data.rate_limits.five_hour ? {
        utilization: newFiveHour,
        resetsAt: data.rate_limits.five_hour.resets_at,
      } : null,
      sevenDay: {
        utilization: newSevenDay,
        resetsAt: data.rate_limits.seven_day.resets_at,
      },
      sessionId: data.session_id,
      updatedAt: Date.now(),
    };

    writeFileSync(rateLimitsFile, JSON.stringify(payload), 'utf-8');
  } catch {
    // 写入失败不影响 statusline 渲染
  }
}

/**
 * 主函数
 */
async function main() {
  try {
    // 1. 读取 stdin
    const input = await readStdin();

    if (!input || input.trim() === '') {
      console.log(chalk.gray('No input'));
      return;
    }

    // 2. 解析 JSON
    let data: ClaudeStatusJSON;
    try {
      data = JSON.parse(input);
    } catch (error) {
      console.log(chalk.red('Invalid JSON'));
      return;
    }

    // 3. 检测 session 切换（内部 /resume 命令）
    detectSessionSwitch(data.session_id);

    // 3.5. 持久化 rate_limits 到本地文件供 ClaudeMonitorKit 读取
    persistRateLimits(data);

    // 追加 usage log（rate_limits 变化时记录，兜底 ETerm 插件记录断档）
    if (data.rate_limits?.seven_day) {
      try {
        const logDir = join(process.env.HOME || '', '.vimo');
        const logFile = join(logDir, 'usage-log.jsonl');
        const sd = data.rate_limits.seven_day;
        const fh = data.rate_limits.five_hour;
        const line = JSON.stringify({
          ts: Date.now(),
          sid: data.session_id,
          sd: Math.round(sd.used_percentage),
          fh: fh ? Math.round(fh.used_percentage) : null,
          resetsAt: sd.resets_at,
        }) + '\n';
        const { appendFileSync } = await import('fs');
        appendFileSync(logFile, line, 'utf-8');
      } catch {}
    }


    // 4. 获取 vlaude 状态
    const vlaudeStatus = await getVlaudeStatus(data.session_id || null);

    // 5. 获取 context percentage — 优先用 CC 的 context_window
    let contextPercentage: number | null = null;
    if (data.context_window?.used_percentage != null) {
      contextPercentage = data.context_window.used_percentage;
    } else {
      const contextLength = await getContextLength(data.transcript_path);
      if (contextLength !== null) {
        const maxTokens = getModelMaxTokens(data.model?.id);
        contextPercentage = Math.min(100, (contextLength / maxTokens) * 100);
      }
    }

    // 6. 获取 token metrics — 从 transcript 累计（用于 R/W/‰ 会话级消耗）
    const tokenMetrics = await getTokenMetrics(data.transcript_path);

    // 7. 获取 git 变更
    const gitChanges = getGitChanges();

    // 8. 渲染状态栏
    const statusLine = renderStatusLine(data, vlaudeStatus, contextPercentage, tokenMetrics, gitChanges);

    // 7. 输出（添加 reset 代码覆盖 Claude Code 的 dim 设置）
    // Replace all spaces with non-breaking spaces to prevent trimming
    const outputLine = '\x1b[0m' + statusLine.replace(/ /g, '\u00A0');
    console.log(outputLine);
  } catch (error) {
    // 发生错误时，至少输出一个简单的状态栏
    console.log(chalk.gray('Claude Code'));
  }
}

main();
