#!/usr/bin/env node

import chalk from 'chalk';
import { readStdin } from './statusline/input';
import { getVlaudeStatus } from './statusline/vlaude-client';
import { getContextLength } from './statusline/context';
import { getTokenMetrics } from './statusline/tokens';
import { getGitChanges } from './statusline/git';
import { renderStatusLine } from './statusline/renderer';
import type { ClaudeStatusJSON } from './statusline/types';

// 设置 chalk 颜色级别为 24-bit (truecolor)
chalk.level = 3;

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

    // 3. 获取 vlaude 状态
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
