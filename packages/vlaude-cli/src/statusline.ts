#!/usr/bin/env node

import chalk from 'chalk';
import { readStdin } from './statusline/input';
import { getVlaudeStatus } from './statusline/vlaude-client';
import { getContextLength } from './statusline/context';
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

    // 4. 获取 vlaude 状态
    const vlaudeStatus = await getVlaudeStatus(data.session_id || null);

    // 4. 获取 context length 和 token metrics
    const contextLength = await getContextLength(data.transcript_path);
    const tokenMetrics = await getTokenMetrics(data.transcript_path);

    // 5. 获取 git 变更
    const gitChanges = getGitChanges();

    // 6. 渲染状态栏
    const statusLine = renderStatusLine(data, vlaudeStatus, contextLength, tokenMetrics, gitChanges);

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
