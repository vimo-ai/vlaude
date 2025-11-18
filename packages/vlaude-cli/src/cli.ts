#!/usr/bin/env node

import { spawn, ChildProcess } from 'child_process';
import { io, Socket } from 'socket.io-client';
import { homedir } from 'os';
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
    const projectPath = getCurrentProjectPath();

    console.log(chalk.gray(`📝 Resuming session: ${sessionId}`));
    console.log(chalk.gray(`   Project: ${projectPath}`));

    return { sessionId };
  }

  // 新建 session - 我们先不知道 sessionId,让 claude 自己创建
  console.log(chalk.gray('📝 Creating new session...'));
  return null;
}


// 全局变量存储当前运行的 Claude 进程和切换函数
let currentClaudeProcess: ChildProcess | null = null;
let currentSwitchHandler: (() => void) | null = null;
let currentRemoteModeResolver: (() => void) | null = null;

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
    console.log(chalk.blue('🖥️  Local mode - You can use Claude normally'));
    console.log(chalk.gray(`Session: ${sessionId}\n`));

    // DEBUG: 打印实际传递给 claude 的参数
    console.log(chalk.yellow('[DEBUG] Spawning claude with:'));
    console.log(chalk.yellow(`  args: ${JSON.stringify(args)}`));
    console.log(chalk.yellow(`  cwd: ${process.cwd()}`));
    console.log(chalk.yellow(`  stdin.isTTY: ${process.stdin.isTTY}`));
    console.log(chalk.yellow(`  stdout.isTTY: ${process.stdout.isTTY}\n`));

    // Pause stdin before spawning (like happy-cli does)
    process.stdin.pause();

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

      // Resume stdin after process exits
      process.stdin.resume();

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

      // Resume stdin on error
      process.stdin.resume();

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
  const controlSocket = io(SERVER_URL);

  controlSocket.on('connect', () => {
    if (currentSessionId) {
      controlSocket.emit('join', { sessionId: currentSessionId, clientType: 'cli', projectPath });
      console.log(chalk.gray('✅ Connected to Vlaude server'));
      console.log(chalk.gray(`   Session: ${currentSessionId}`));
      console.log(chalk.gray(`   Project: ${projectPath}`));
      console.log(chalk.gray(`   Client type: cli\n`));
    } else {
      console.log(chalk.gray('✅ Connected to Vlaude server (waiting for session creation)'));
    }
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
        // 如果没有 sessionId，请求 Daemon 监听新 session 创建
        if (!currentSessionId) {
          console.log(chalk.gray('📝 Creating new session...'));
          console.log(chalk.gray('   Requesting Daemon to watch for new session files...'));

          // 发送监听请求
          controlSocket.emit('watch-new-session', { projectPath });

          // 等待新 session 创建的通知
          const newSessionPromise = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Timeout waiting for new session creation'));
            }, 30000);

            controlSocket.once('new-session-created', (data: { sessionId: string; projectPath: string }) => {
              clearTimeout(timeout);
              console.log(chalk.green(`✅ New session created: ${data.sessionId}`));
              resolve(data.sessionId);
            });
          });

          // 同时启动 Claude 进程
          const claudePromise = runLocalMode(args, 'new-session');

          try {
            // 等待新 session ID
            currentSessionId = await Promise.race([
              newSessionPromise,
              claudePromise.then(() => {
                throw new Error('Claude exited before session was created');
              })
            ]);

            // 成功获取到 sessionId，加入 server
            if (controlSocket.connected) {
              controlSocket.emit('join', { sessionId: currentSessionId, clientType: 'cli', projectPath });
              console.log(chalk.gray(`\n✅ Session created and joined: ${currentSessionId}\n`));
            }

            // 继续等待 Claude 进程完成
            const result = await claudePromise;
            if (result === 'exit') {
              shouldExit = true;
            } else if (result === 'switch') {
              mode = 'remote';
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
        // 通知 Server 恢复 FileWatcher 推送（切回 Local 模式）
        console.log(chalk.blue('📡 Notifying server to resume FileWatcher...'));
        controlSocket.emit('cli:resumeLocal', { sessionId: currentSessionId });
      }
    }
  }

  controlSocket.close();
  console.log(chalk.gray('\nVlaude CLI exited'));
}

main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
