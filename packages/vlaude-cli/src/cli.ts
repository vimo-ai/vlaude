#!/usr/bin/env node

import { spawn, ChildProcess } from 'child_process';
import { io, Socket } from 'socket.io-client';
import { homedir } from 'os';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const SERVER_URL = 'http://localhost:10005';
const DAEMON_URL = 'http://localhost:10006';

interface SessionInfo {
  sessionId: string;
}

/**
 * 获取当前项目路径
 */
function getCurrentProjectPath(): string {
  return process.cwd();
}

/**
 * 获取 session ID (如果用户使用 --resume 或 -r)
 * CLI 不再处理文件路径，只提取 sessionId 参数
 */
async function getSessionId(args: string[]): Promise<SessionInfo | null> {
  // 检查 --resume 或 -r 参数
  let resumeIndex = args.indexOf('--resume');
  if (resumeIndex === -1) {
    resumeIndex = args.indexOf('-r');
  }

  // 如果用户明确指定 --resume 或 -r,返回 session 信息
  if (resumeIndex !== -1 && args[resumeIndex + 1]) {
    const sessionId = args[resumeIndex + 1];
    return { sessionId };
  }

  // 新建 session - 我们先不知道 sessionId,让 claude 自己创建
  return null;
}


// 全局变量存储当前运行的 Claude 进程和切换函数
let currentClaudeProcess: ChildProcess | null = null;
let currentSwitchHandler: (() => void) | null = null;
let currentRemoteModeResolver: (() => void) | null = null;
let statusUpdateInterval: NodeJS.Timeout | null = null;

/**
 * 轮询检测 Claude Code 创建的新 session 文件
 * 通过 daemon 扫描所有项目目录，找到最新创建的 session 文件
 */
function pollForNewSessionFile(socket: Socket, projectPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for session file creation'));
    }, 30000);

    // 向 daemon 请求查找新 session
    socket.emit('find-new-session', { projectPath });

    // 等待 daemon 响应
    socket.once('new-session-found', (data: { sessionId: string; projectPath: string }) => {
      clearTimeout(timeout);
      resolve(data.sessionId);
    });

    socket.once('new-session-not-found', () => {
      clearTimeout(timeout);
      reject(new Error('No new session found'));
    });
  });
}

/**
 * 更新 socket 连接状态文件
 * statusline 会读取这个文件来判断 WebSocket 是否连接
 *
 * 状态文件存储在项目的 .vlaude 目录下：
 * {projectPath}/.vlaude/session-{sessionId}.status
 */
function updateSocketStatus(sessionId: string | null, connected: boolean, mode: 'local' | 'remote', projectPath: string) {
  if (!sessionId) return;

  try {
    // 确保 .vlaude 目录存在
    const vlaudeDir = join(projectPath, '.vlaude');
    if (!existsSync(vlaudeDir)) {
      mkdirSync(vlaudeDir, { recursive: true });
    }

    // 写入状态文件
    const statusFile = join(vlaudeDir, `session-${sessionId}.status`);
    writeFileSync(statusFile, JSON.stringify({
      sessionId,
      connected,
      mode,
      timestamp: Date.now()
    }), 'utf-8');
  } catch (error) {
    // 静默失败，不影响主流程
  }
}

/**
 * 本地模式：运行 Claude Code
 * 返回 'exit' 表示正常退出，'switch' 表示需要切换到 remote 模式
 *
 * 注意：切换到 remote 模式时会杀掉 Claude CLI 进程
 * 因为 Daemon 会使用 claude-agent-sdk 的 query() 方法接管会话
 */
function runLocalMode(
  args: string[],
  sessionId: string
): Promise<'exit' | 'switch'> {
  return new Promise((resolve, reject) => {
    // Local mode - status will be shown by vlaude-statusline

    // 不需要 pause stdin，因为 stdio: 'inherit' 会让子进程直接接管
    // process.stdin.pause();

    // Use the latest claude from ~/.claude/local/claude
    // This ensures we use the auto-updated version (2.0.43) instead of
    // potentially outdated global installations (e.g., nvm's 2.0.36)
    const claudePath = process.env.CLAUDE_CLI_PATH ||
                       (homedir() + '/.claude/local/claude');

    currentClaudeProcess = spawn(claudePath, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: {
        ...process.env,
        DISABLE_AUTOUPDATER: '1'
      }
    });

    let shouldSwitch = false;

    // 注册切换回调（存储到全局变量）
    currentSwitchHandler = () => {
      shouldSwitch = true;
      if (currentClaudeProcess) {
        console.log(chalk.yellow('\n📱 Mobile device connected, switching to remote mode...'));
        console.log(chalk.yellow('   Stopping local Claude CLI (Daemon will take over using SDK)'));
        currentClaudeProcess.kill('SIGTERM');
      }
    };

    currentClaudeProcess.on('exit', (code) => {
      currentClaudeProcess = null;
      currentSwitchHandler = null;

      // 不需要 resume，因为我们没有 pause
      // process.stdin.resume();

      if (shouldSwitch) {
        resolve('switch');
      } else if (code === 0) {
        resolve('exit');
      } else {
        reject(new Error(`Claude process exited with code ${code}`));
      }
    });

    currentClaudeProcess.on('error', (error) => {
      currentClaudeProcess = null;
      currentSwitchHandler = null;

      // 不需要 resume，因为我们没有 pause
      // process.stdin.resume();

      reject(error);
    });
  });
}

/**
 * Remote 模式：显示等待界面
 * 注意：不再创建新的 socket，而是等待 controlSocket 的事件
 */
function runRemoteMode(sessionId: string, serverURL: string): Promise<'switch'> {
  return new Promise((resolve) => {
    console.clear();
    console.log(chalk.yellow('📱 Remote Mode'));
    console.log(chalk.yellow('━'.repeat(60)));
    console.log(chalk.gray('Mobile device is controlling this session.'));
    console.log(chalk.gray('All inputs are disabled until mobile disconnects.\n'));
    console.log(chalk.gray(`Session: ${sessionId}`));
    console.log(chalk.gray(`Server: ${serverURL}`));
    console.log(chalk.gray('\nPress "q" or ESC to exit remote mode'));
    console.log(chalk.gray('Press Ctrl+C to force exit\n'));

    // 设置 stdin 为 raw 模式以捕获按键
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
    }

    const cleanup = () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      process.stdin.removeAllListeners('data');
      currentRemoteModeResolver = null;
    };

    // 监听键盘输入
    const keyHandler = (key: string) => {
      // Ctrl+C
      if (key === '\u0003') {
        console.log(chalk.yellow('\n\nForce exiting...'));
        cleanup();
        process.exit(0);
      }
      // q 或 ESC
      if (key === 'q' || key === '\u001b') {
        console.log(chalk.blue('\n\n👋 Exiting remote mode...'));
        console.log(chalk.blue('Switching back to local mode...\n'));
        cleanup();
        resolve('switch');
      }
    };

    process.stdin.on('data', keyHandler);

    // 将 resolver 保存到全局变量，以便 controlSocket 的 remote-disconnect 事件可以触发
    currentRemoteModeResolver = () => {
      cleanup();
      resolve('switch');
    };
  });
}

/**
 * 主循环
 */
async function main() {
  const args = process.argv.slice(2);
  const sessionInfo = await getSessionId(args);

  let mode: 'local' | 'remote' = 'local';
  let shouldExit = false;
  let currentSessionId: string | null = sessionInfo?.sessionId || null;
  const projectPath = getCurrentProjectPath();

  // 创建全局 socket 监听模式切换
  const controlSocket = io(SERVER_URL, {
    reconnection: true,              // 启用自动重连
    reconnectionDelay: 1000,         // 重连延迟 1秒
    reconnectionDelayMax: 5000,      // 最大重连延迟 5秒
    reconnectionAttempts: Infinity,  // 无限重试
    timeout: 20000,                  // 连接超时 20秒
  });

  let isFirstConnect = true;

  controlSocket.on('connect', () => {
    if (isFirstConnect) {
      console.log(chalk.green('✅ Connected to Vlaude server'));
      isFirstConnect = false;
    }

    if (currentSessionId) {
      controlSocket.emit('join', { sessionId: currentSessionId, clientType: 'cli', projectPath });
      updateSocketStatus(currentSessionId, true, mode, projectPath);
    }

    // 启动状态文件心跳更新（每 2 秒）
    // 确保 statusline 能持续读取到最新的连接状态
    if (statusUpdateInterval) clearInterval(statusUpdateInterval);
    statusUpdateInterval = setInterval(() => {
      if (currentSessionId) {
        updateSocketStatus(currentSessionId, controlSocket.connected, mode, projectPath);
      }
    }, 2000);
  });

  controlSocket.on('disconnect', (reason) => {
    console.log(chalk.yellow(`⚠️ Disconnected from server: ${reason}`));
    if (currentSessionId) {
      updateSocketStatus(currentSessionId, false, mode, projectPath);
    }

    // 停止心跳
    if (statusUpdateInterval) {
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
    }
  });

  controlSocket.on('reconnect', (attemptNumber) => {
    console.log(chalk.green(`🔄 Reconnected to server (after ${attemptNumber} attempts)`));
  });

  controlSocket.on('reconnect_attempt', (attemptNumber) => {
    if (attemptNumber === 1 || attemptNumber % 3 === 0) {
      console.log(chalk.gray(`🔄 Reconnecting... (attempt ${attemptNumber})`));
    }
  });

  controlSocket.on('connect_error', (error) => {
    console.log(chalk.red(`❌ Connection error: ${error.message}`));
  });

  controlSocket.on('reconnect_failed', () => {
    console.log(chalk.red('❌ Failed to reconnect after max attempts'));
  });

  controlSocket.on('remote-connect', () => {
    console.log(chalk.yellow('\n📱 [EVENT] remote-connect received!'));
    console.log(chalk.yellow(`   Current mode: ${mode}`));
    console.log(chalk.yellow(`   currentSwitchHandler exists: ${!!currentSwitchHandler}`));

    // 只有在 local 模式且有 switchHandler 时，才触发切换
    // 不在这里修改 mode，让主循环自己管理
    if (mode === 'local' && currentSwitchHandler) {
      console.log(chalk.yellow('   Calling switchHandler to kill Claude process...'));
      currentSwitchHandler();
    } else {
      console.log(chalk.yellow('   Ignoring remote-connect (not ready to switch)'));
    }
  });

  controlSocket.on('remote-disconnect', () => {
    console.log(chalk.blue('\n📱 [EVENT] remote-disconnect received!'));

    // 如果正在 remote 模式，触发切换回 local
    // 不在这里修改 mode，让主循环自己管理
    if (currentRemoteModeResolver) {
      console.log(chalk.blue('   Calling remoteModeResolver to exit remote mode...'));
      currentRemoteModeResolver();
    } else {
      console.log(chalk.blue('   No remoteModeResolver available (not in remote mode)'));
    }
  });

  // 主循环
  while (!shouldExit) {
    if (mode === 'local') {
      try {
        // 如果没有 sessionId，启动新的 Claude 进程并检测 session
        if (!currentSessionId) {
          // 启动 Claude 进程
          const claudePromise = runLocalMode(args, 'new-session');

          // 查找 session 文件（daemon 会轮询重试）
          const sessionIdPromise = pollForNewSessionFile(controlSocket, projectPath);

          try {
            // 等待新 session ID
            currentSessionId = await Promise.race([
              sessionIdPromise,
              claudePromise.then(() => {
                throw new Error('Claude exited before session was created');
              })
            ]);

            // 成功获取到 sessionId，加入 server
            if (controlSocket.connected) {
              controlSocket.emit('join', { sessionId: currentSessionId, clientType: 'cli', projectPath });
              // 创建状态文件，让 statusline 显示连接状态
              updateSocketStatus(currentSessionId, true, mode, projectPath);
            }

            // 继续等待 Claude 进程完成
            const result = await claudePromise;
            if (result === 'exit') {
              shouldExit = true;
            } else if (result === 'switch') {
              mode = 'remote';
              updateSocketStatus(currentSessionId, controlSocket.connected, mode, projectPath);
            }
          } catch (error) {
            console.error(chalk.red('Error creating session:'), error);
            shouldExit = true;
          }
        } else {
          // 使用 --resume 运行
          const resumeArgs = ['--resume', currentSessionId];
          const result = await runLocalMode(resumeArgs, currentSessionId);

          if (result === 'exit') {
            shouldExit = true;
          } else if (result === 'switch') {
            mode = 'remote';
            updateSocketStatus(currentSessionId, controlSocket.connected, mode, projectPath);
          }
        }
      } catch (error) {
        console.error(chalk.red('Error in local mode:'), error);
        shouldExit = true;
      }
    } else if (mode === 'remote') {
      if (!currentSessionId) {
        console.log(chalk.red('Error: Cannot enter remote mode without session ID'));
        shouldExit = true;
        break;
      }
      const result = await runRemoteMode(currentSessionId, SERVER_URL);
      if (result === 'switch') {
        mode = 'local';
        updateSocketStatus(currentSessionId, controlSocket.connected, mode, projectPath);
        // 通知 Server 恢复 FileWatcher 推送（切回 Local 模式）
        console.log(chalk.blue('📡 Notifying server to resume FileWatcher...'));
        controlSocket.emit('cli:resumeLocal', { sessionId: currentSessionId });
      }
    }
  }

  // 清理心跳定时器
  if (statusUpdateInterval) {
    clearInterval(statusUpdateInterval);
    statusUpdateInterval = null;
  }

  controlSocket.close();
  console.log(chalk.gray('\nVlaude CLI exited'));
}

main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
