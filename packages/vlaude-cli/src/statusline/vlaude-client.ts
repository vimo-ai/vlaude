import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { VlaudeStatus } from './types';

/**
 * 从状态文件获取 vlaude WebSocket 连接状态
 *
 * CLI 主进程会在 socket 连接状态变化时更新这个文件，
 * statusline 通过读取文件来判断 WebSocket 是否连接，
 * 避免了频繁创建临时 WebSocket 连接产生的日志噪音。
 *
 * 状态文件位置：{projectPath}/.vlaude/session-{sessionId}.status
 */
export async function getVlaudeStatus(sessionId: string | null): Promise<VlaudeStatus> {
  // 如果没有 sessionId，说明不在 vlaude 会话中
  if (!sessionId) {
    return { connected: false };
  }

  // 状态文件在当前项目的 .vlaude 目录下
  // statusline 运行在项目目录中，所以直接使用 process.cwd()
  const projectPath = process.cwd();
  const statusFile = join(projectPath, '.vlaude', `session-${sessionId}.status`);

  try {
    // 检查文件是否存在
    if (!existsSync(statusFile)) {
      return { connected: false };
    }

    // 读取状态文件
    const content = readFileSync(statusFile, 'utf-8');
    const status = JSON.parse(content);

    // 检查时间戳是否过期（5秒内的状态才有效）
    const age = Date.now() - status.timestamp;
    if (age > 5000) {
      return { connected: false };
    }

    return {
      connected: status.connected,
      mode: status.mode || 'local',
    };
  } catch (error) {
    // 文件读取失败或解析失败，返回未连接
    return { connected: false };
  }
}
