#!/usr/bin/env node

import { spawn, ChildProcess } from 'child_process';
import { io, Socket } from 'socket.io-client';
import { homedir } from 'os';
import { writeFileSync, mkdirSync, existsSync, watch, readFileSync, unlinkSync, appendFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import chalk from 'chalk';

const SERVER_URL = 'http://localhost:10005';
const DAEMON_URL = 'http://localhost:10006';

interface SessionInfo {
  sessionId: string;
}

// 日志文件路径（在 main 函数中初始化）
let logFilePath: string | null = null;
let isDebugMode: boolean = false;  // 调试模式标志

/**
 * 写入日志到 .vlaude/cli.log
 * 只在调试模式下（VLAUDE_DEBUG=1）才真正写入
 */
function log(message: string, data?: any) {
  // 如果未开启调试模式，直接返回
  if (!isDebugMode || !logFilePath) return;

  const timestamp = new Date().toISOString();
  let logMessage = `[${timestamp}] ${message}`;

  if (data !== undefined) {
    if (typeof data === 'object') {
      logMessage += '\n' + JSON.stringify(data, null, 2);
    } else {
      logMessage += ' ' + String(data);
    }
  }

  try {
    appendFileSync(logFilePath, logMessage + '\n');
  } catch (err) {
    // 静默失败，不影响主流程
  }
}

/**
 * 获取当前项目路径
 */
function getCurrentProjectPath(): string {
  return process.cwd();
}


/**
 * 获取 vlaude 自定义 Claude 启动器的路径
 */
function getClaudeLauncherPath(): string {
  // 在开发环境中，启动器位于 scripts/claude-launcher.cjs
  // 在生产环境中，启动器会被打包到 dist/scripts/
  const scriptPath = join(__dirname, '..', 'scripts', 'claude-launcher.cjs');
  if (existsSync(scriptPath)) {
    return scriptPath;
  }

  // 尝试从 dist 查找
  const distPath = join(__dirname, 'scripts', 'claude-launcher.cjs');
  if (existsSync(distPath)) {
    return distPath;
  }

  throw new Error('Claude launcher script not found');
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
let needsStdinCleanup: boolean = false;  // 标记是否需要清理 stdin（从 remote mode 切回时）

/**
 * 监听 Statusline 发出的 session 切换信号
 *
 * 工作原理：
 * 1. Statusline 检测到 session_id 变化（内部 /resume）
 * 2. 写入信号文件：.vlaude/session-switch.signal
 * 3. CLI 监听这个文件的变化
 * 4. 读取新的 sessionId 并调用回调
 *
 * 这个机制可以检测到 Claude Code 内部的 /resume 切换！
 */
function startSessionSwitchMonitor(
  projectPath: string,
  onSwitch: (sessionId: string) => void
): () => void {
  const vlaudeDir = join(projectPath, '.vlaude');
  const signalFile = join(vlaudeDir, 'session-switch.signal');

  // 确保目录存在
  if (!existsSync(vlaudeDir)) {
    mkdirSync(vlaudeDir, { recursive: true });
  }

  // 监听 .vlaude 目录
  const watcher = watch(vlaudeDir, (event, filename) => {
    // 忽略状态文件的变化，只关注信号文件
    if (!filename || filename.endsWith('.status') || filename === 'last-session-id') {
      return;
    }

    if (filename === 'session-switch.signal') {
      try {
        // 读取信号文件
        if (existsSync(signalFile)) {
          const data = JSON.parse(readFileSync(signalFile, 'utf-8'));
          const newSessionId = data.currentSessionId;

          // 调用回调
          onSwitch(newSessionId);

          // 删除信号文件（避免重复触发）
          try {
            unlinkSync(signalFile);
          } catch (err) {
            // 删除失败，忽略
          }
        }
      } catch (err) {
        // 文件读取或解析失败，忽略
      }
    }
  });

  return () => watcher.close();
}

/**
 * 检测 Claude Code 生成的 UUID（通过 Monkey Patch fd 3）
 *
 * 工作原理：
 * 1. 从 Claude 启动器的 fd 3 接收 UUID（通过 Monkey Patch crypto.randomUUID）
 * 2. 将 UUID 通过 WebSocket 发送给 Server
 * 3. Server 协调 Daemon 的文件系统检测进行匹配
 * 4. 匹配成功后，Server 通知 CLI 确认的 sessionId
 */
function detectUUIDFromLauncher(
  childProcess: ChildProcess,
  controlSocket: any,
  projectPath: string
): () => void {
  // 监听 fd 3（接收 Claude 启动器发送的 UUID）
  let readlineInterface: ReturnType<typeof createInterface> | null = null;
  if (childProcess.stdio[3]) {
    readlineInterface = createInterface({
      input: childProcess.stdio[3] as any,
      crlfDelay: Infinity
    });

    readlineInterface.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type === 'uuid') {
          const uuid = message.value;

          // 通过 WebSocket 发送 UUID 给 Server
          if (controlSocket.connected) {
            controlSocket.emit('cli:reportUUID', { uuid, projectPath });
          }
        }
      } catch (err) {
        // 非 JSON 行，忽略
      }
    });
  }

  // 返回清理函数
  return () => {
    if (readlineInterface) {
      readlineInterface.close();
    }
  };
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
 * 清理 session 状态文件
 * 在 CLI 退出时调用，删除当前 session 的状态文件
 */
function cleanupSessionStatus(sessionId: string | null, projectPath: string) {
  if (!sessionId) return;

  try {
    const vlaudeDir = join(projectPath, '.vlaude');
    const statusFile = join(vlaudeDir, `session-${sessionId}.status`);

    if (existsSync(statusFile)) {
      unlinkSync(statusFile);
    }
  } catch (err) {
    // 删除失败，忽略
  }
}

/**
 * 本地模式：运行 Claude Code
 * 返回 'exit' 表示正常退出，'switch' 表示需要切换到 remote 模式
 *
 * 新架构：
 * - 使用自定义 Claude 启动器（Monkey Patch crypto.randomUUID）
 * - 通过 fd 3 接收 UUID
 * - 双向匹配确定 sessionId
 */
function runLocalMode(
  args: string[],
  sessionId: string | null,
  projectPath: string,
  controlSocket: any,
  onSessionFound: (sessionId: string) => void
): Promise<'exit' | 'switch'> {
  return new Promise((resolve, reject) => {
    let cleanupDetector: (() => void) | null = null;

    try {
      log('runLocalMode: Starting', {
        sessionId,
        hasSessionId: !!sessionId,
        originalArgs: args,
        hasResumeInArgs: args.includes('--resume') || args.includes('-r')
      });

      // 彻底清理 stdin 状态（仅在从 remote mode 切回时）
      // 确保 stdin 处于正常的 cooked mode，否则会影响 Claude 子进程的输入
      if (needsStdinCleanup && process.stdin.isTTY) {
        log('runLocalMode: Cleaning up stdin state after remote mode');
        try {
          // 1. 关闭 raw mode
          process.stdin.setRawMode(false);
          // 2. 移除所有 data 监听器（remote mode 添加的）
          process.stdin.removeAllListeners('data');
          log('runLocalMode: stdin cleaned up successfully');
        } catch (err) {
          log('runLocalMode: stdin cleanup warning', err);
          // 继续执行，stdin 清理失败不应该阻止启动
        }
        // 清理完成，重置标志
        needsStdinCleanup = false;
      } else if (needsStdinCleanup) {
        log('runLocalMode: stdin cleanup skipped (not TTY)');
        needsStdinCleanup = false;
      }

      // 获取自定义 Claude 启动器路径
      const launcherPath = getClaudeLauncherPath();

      // 动态构建 Claude 参数
      let claudeArgs = [...args];

      // 如果有 sessionId 但 args 里没有 --resume，添加 --resume
      // 这样从 remote mode 切回 local 时，可以恢复原会话而不是创建新会话
      if (sessionId && !args.includes('--resume') && !args.includes('-r')) {
        claudeArgs = ['--resume', sessionId, ...args];
        log('runLocalMode: Added --resume to args', {
          sessionId,
          claudeArgs
        });
      } else {
        log('runLocalMode: Using original args', {
          reason: !sessionId ? 'no sessionId' : 'args already has --resume',
          claudeArgs
        });
      }

      // 启动 Claude Code（通过自定义启动器）
      // 注意：stdio 的第 4 个参数（fd 3）设置为 'pipe'，用于接收 UUID
      log('runLocalMode: Spawning Claude process', {
        launcherPath,
        claudeArgs,
        cwd: projectPath
      });

      currentClaudeProcess = spawn('node', [launcherPath, ...claudeArgs], {
        stdio: ['inherit', 'inherit', 'inherit', 'pipe'],  // fd 3 用于接收 UUID
        cwd: projectPath,
        env: {
          ...process.env,
          DISABLE_AUTOUPDATER: '1'
        }
      });

      // 如果是新 session（没有 --resume），需要检测 UUID 并发送给 Server
      if (!sessionId) {
        log('runLocalMode: Setting up UUID detector (new session)');
        cleanupDetector = detectUUIDFromLauncher(
          currentClaudeProcess,
          controlSocket,
          projectPath
        );
      } else {
        log('runLocalMode: Using existing sessionId', sessionId);
        // --resume 场景，直接使用已知的 sessionId
        onSessionFound(sessionId);
      }

      let shouldSwitch = false;

      // 注册切换回调（存储到全局变量）
      currentSwitchHandler = () => {
        log('runLocalMode: Switch handler called (remote-connect received)');
        shouldSwitch = true;
        if (currentClaudeProcess) {
          console.log(chalk.yellow('\n📱 Mobile device connected, switching to remote mode...'));
          console.log(chalk.yellow('   Stopping local Claude CLI (Daemon will take over using SDK)'));
          log('runLocalMode: Killing Claude process');
          currentClaudeProcess.kill('SIGTERM');
        }
      };

      currentClaudeProcess.on('exit', (code) => {
        log('runLocalMode: Claude process exited', {
          code,
          shouldSwitch
        });

        if (cleanupDetector) {
          cleanupDetector();
          cleanupDetector = null;
        }
        currentClaudeProcess = null;
        currentSwitchHandler = null;

        if (shouldSwitch) {
          log('runLocalMode: Resolving with "switch"');
          resolve('switch');
        } else if (code === 0) {
          log('runLocalMode: Resolving with "exit"');
          resolve('exit');
        } else {
          log('runLocalMode: Rejecting with error', { code });
          reject(new Error(`Claude process exited with code ${code}`));
        }
      });

      currentClaudeProcess.on('error', (error) => {
        log('runLocalMode: Claude process error', error);

        if (cleanupDetector) {
          cleanupDetector();
          cleanupDetector = null;
        }
        currentClaudeProcess = null;
        currentSwitchHandler = null;
        reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Remote 模式：显示等待界面
 * 注意：不再创建新的 socket，而是等待 controlSocket 的事件
 */
function runRemoteMode(sessionId: string, serverURL: string, controlSocket: any): Promise<'switch'> {
  return new Promise((resolve) => {
    log('runRemoteMode: Entering remote mode', { sessionId });

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
      controlSocket.off('server:exitRemoteAllowed', handleExitAllowed);
      controlSocket.off('server:exitRemoteDenied', handleExitDenied);
      currentRemoteModeResolver = null;

      // 标记需要清理 stdin，下次进入 local mode 时会清理
      needsStdinCleanup = true;
      log('runRemoteMode: cleanup complete, marked stdin for cleanup');
    };

    // Server 允许退出的回调
    const handleExitAllowed = () => {
      log('runRemoteMode: Exit allowed by server');
      console.log(chalk.blue('\n\n👋 Exiting remote mode...'));
      console.log(chalk.blue('Switching back to local mode...\n'));
      cleanup();
      resolve('switch');
    };

    // Server 拒绝退出的回调（Claude 正在思考）
    const handleExitDenied = (data: { reason: string }) => {
      log('runRemoteMode: Exit denied by server', data);
      console.log(chalk.yellow('\n⏸️  Claude is thinking, please wait...'));
      console.log(chalk.gray('Press "q" again to exit when ready\n'));
    };

    // 监听 Server 的回复
    controlSocket.on('server:exitRemoteAllowed', handleExitAllowed);
    controlSocket.on('server:exitRemoteDenied', handleExitDenied);

    // 监听键盘输入
    const keyHandler = (key: string) => {
      // Ctrl+C
      if (key === '\u0003') {
        log('runRemoteMode: Force exit (Ctrl+C)');
        console.log(chalk.yellow('\n\nForce exiting...'));
        cleanup();
        process.exit(0);
      }
      // q 或 ESC
      if (key === 'q' || key === '\u001b') {
        log('runRemoteMode: User pressed q/ESC, requesting exit', { sessionId });
        console.log(chalk.gray('\n\nRequesting to exit remote mode...'));
        // 向 Server 请求退出
        controlSocket.emit('cli:requestExitRemote', { sessionId });
        // 不立即退出，等待 Server 回复
      }
    };

    process.stdin.on('data', keyHandler);

    // 将 resolver 保存到全局变量，以便 controlSocket 的 remote-disconnect 事件可以触发
    currentRemoteModeResolver = () => {
      log('runRemoteMode: remoteModeResolver called (remote-disconnect)');
      cleanup();
      resolve('switch');
    };

    log('runRemoteMode: Setup complete, waiting for events');
  });
}

/**
 * 主循环
 */
async function main() {
  const args = process.argv.slice(2);
  const projectPath = getCurrentProjectPath();

  // 检查是否开启调试模式（通过环境变量 VLAUDE_DEBUG）
  isDebugMode = process.env.VLAUDE_DEBUG === '1' || process.env.VLAUDE_DEBUG === 'true';

  // 只在调试模式下初始化日志文件
  if (isDebugMode) {
    const vlaudeDir = join(projectPath, '.vlaude');
    if (!existsSync(vlaudeDir)) {
      mkdirSync(vlaudeDir, { recursive: true });
    }
    logFilePath = join(vlaudeDir, 'cli.log');

    // 清空旧日志（每次启动时重新开始）
    writeFileSync(logFilePath, '');

    log('=== Vlaude CLI Started (Debug Mode) ===');
    log('Project path:', projectPath);
    log('Command args:', args);
  }

  // 读取 package.json
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

  log('CLI version:', pkg.version);

  // 处理 --version 参数
  if (args.includes('--version') || args.includes('-v')) {
    console.log(chalk.cyan('╭─────────────────────────────────────╮'));
    console.log(chalk.cyan('│') + chalk.bold.white('  Vlaude CLI') + '                       ' + chalk.cyan('│'));
    console.log(chalk.cyan('├─────────────────────────────────────┤'));
    console.log(chalk.cyan('│') + '  Version: ' + chalk.green(pkg.version) + '                     ' + chalk.cyan('│'));
    console.log(chalk.cyan('│') + '  Server:  ' + chalk.blue(SERVER_URL) + chalk.cyan('│'));
    console.log(chalk.cyan('╰─────────────────────────────────────╯'));
    console.log('');

    // 继续透传给 Claude Code
    // 这样既显示 vlaude 信息，也显示 Claude 信息
  }

  // 显示启动日志
  console.log(chalk.gray('━'.repeat(60)));
  console.log(chalk.cyan(`🚀 Vlaude CLI v${pkg.version}`) + chalk.gray(` | Server: ${SERVER_URL}`));
  if (isDebugMode) {
    console.log(chalk.yellow('🐛 Debug Mode: Logging to .vlaude/cli.log'));
  }
  console.log(chalk.gray('━'.repeat(60)));

  const sessionInfo = await getSessionId(args);
  log('Session info parsed:', sessionInfo);

  let mode: 'local' | 'remote' = 'local';
  let shouldExit = false;
  let currentSessionId: string | null = sessionInfo?.sessionId || null;

  log('Initial state:', { mode, currentSessionId });

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
    log('Socket connected', { isFirstConnect, currentSessionId, mode });

    if (isFirstConnect) {
      console.log(chalk.green('✅ Connected to Vlaude Server'));
      console.log(chalk.gray(`   Project: ${projectPath}`));
      if (currentSessionId) {
        console.log(chalk.gray(`   Session: ${currentSessionId.substring(0, 8)}...`));
      }
      isFirstConnect = false;
    }

    if (currentSessionId) {
      log('Emitting join event', { sessionId: currentSessionId, clientType: 'cli' });
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
    log('Socket disconnected', { reason, currentSessionId, mode });

    if (currentSessionId) {
      updateSocketStatus(currentSessionId, false, mode, projectPath);
    }

    // 停止心跳
    if (statusUpdateInterval) {
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
    }
  });

  // 监听 Server 确认的 sessionId（UUID 匹配成功）
  controlSocket.on('server:sessionConfirmed', (data: { sessionId: string }) => {
    log('Received server:sessionConfirmed', data);
    handleSessionFound(data.sessionId);
  });

  controlSocket.on('remote-connect', (data?: { sessionId: string }) => {
    log('Received remote-connect', {
      data,
      currentMode: mode,
      currentSessionId,
      hasSwitchHandler: !!currentSwitchHandler
    });

    // 如果 Server 发送了 sessionId，更新 currentSessionId
    // 这样在新 vlaude 时，即使还没检测到 UUID，也能知道 sessionId
    if (data?.sessionId && !currentSessionId) {
      console.log(chalk.gray(`  Received sessionId from server: ${data.sessionId.substring(0, 8)}...`));
      log('Updating currentSessionId from remote-connect', data.sessionId);
      handleSessionFound(data.sessionId);
    }

    // 只有在 local 模式且有 switchHandler 时，才触发切换
    // 不在这里修改 mode，让主循环自己管理
    if (mode === 'local' && currentSwitchHandler) {
      log('Triggering switch to remote mode');
      currentSwitchHandler();
    } else {
      log('Not triggering switch', {
        reason: mode !== 'local' ? 'not in local mode' : 'no switchHandler'
      });
    }
  });

  controlSocket.on('remote-disconnect', () => {
    log('Received remote-disconnect', {
      currentMode: mode,
      hasRemoteModeResolver: !!currentRemoteModeResolver
    });

    // 如果正在 remote 模式，触发切换回 local
    // 不在这里修改 mode，让主循环自己管理
    if (currentRemoteModeResolver) {
      log('Triggering switch to local mode');
      currentRemoteModeResolver();
    } else {
      log('Not triggering switch - no remoteModeResolver');
    }
  });

  // Session 检测回调（支持多次调用 - 内部 /resume 切换）
  const handleSessionFound = (sessionId: string) => {
    const previousSessionId = currentSessionId;

    log('handleSessionFound called', {
      newSessionId: sessionId,
      previousSessionId,
      mode
    });

    // 如果是同一个 session，不需要处理
    if (previousSessionId === sessionId) {
      log('Same session, no action needed');
      return;
    }

    // 切换 session
    if (previousSessionId) {
      log('Switching session', {
        from: previousSessionId,
        to: sessionId
      });
      // 离开旧 session
      if (controlSocket.connected) {
        controlSocket.emit('leave', { sessionId: previousSessionId });
        // 清理旧 session 的状态文件
        updateSocketStatus(previousSessionId, false, mode, projectPath);
      }
    } else {
      log('Setting initial sessionId', sessionId);
    }

    // 更新当前 session
    currentSessionId = sessionId;

    // 加入新 session
    if (controlSocket.connected) {
      log('Joining new session', sessionId);
      controlSocket.emit('join', { sessionId, clientType: 'cli', projectPath });
      updateSocketStatus(sessionId, true, mode, projectPath);
    }
  };

  // 启动 Statusline 信号监听器（检测内部 /resume 切换）
  const cleanupSessionSwitchMonitor = startSessionSwitchMonitor(projectPath, handleSessionFound);

  // 主循环
  while (!shouldExit) {
    log('=== Main loop iteration ===', { mode, currentSessionId });

    if (mode === 'local') {
      try {
        log('Entering local mode', { currentSessionId, args });
        // 运行 Claude Code（新 session 或 --resume）
        const result = await runLocalMode(args, currentSessionId, projectPath, controlSocket, handleSessionFound);

        log('Local mode exited', { result, currentSessionId });

        if (result === 'exit') {
          log('Exit requested, stopping main loop');
          shouldExit = true;
        } else if (result === 'switch') {
          log('Switching to remote mode');
          mode = 'remote';
          updateSocketStatus(currentSessionId, controlSocket.connected, mode, projectPath);
        }
      } catch (error) {
        log('Error in local mode', error);
        console.error(chalk.red('Error in local mode:'), error);
        shouldExit = true;
      }
    } else if (mode === 'remote') {
      if (!currentSessionId) {
        log('Error: No sessionId for remote mode');
        console.log(chalk.red('Error: Cannot enter remote mode without session ID'));
        shouldExit = true;
        break;
      }

      log('Entering remote mode', { currentSessionId });
      const result = await runRemoteMode(currentSessionId, SERVER_URL, controlSocket);

      log('Remote mode exited', { result });

      if (result === 'switch') {
        log('Switching back to local mode');
        mode = 'local';
        updateSocketStatus(currentSessionId, controlSocket.connected, mode, projectPath);
        // 通知 Server 恢复 FileWatcher 推送（切回 Local 模式）
        console.log(chalk.blue('📡 Notifying server to resume FileWatcher...'));
        controlSocket.emit('cli:resumeLocal', { sessionId: currentSessionId });
      }
    }
  }

  log('=== Main loop ended ===');

  // 清理心跳定时器
  if (statusUpdateInterval) {
    clearInterval(statusUpdateInterval);
    statusUpdateInterval = null;
  }

  // 清理 session switch monitor
  cleanupSessionSwitchMonitor();

  // 清理 session 状态文件
  cleanupSessionStatus(currentSessionId, projectPath);

  controlSocket.close();
  console.log(chalk.gray('\nVlaude CLI exited'));
}

main().catch((error) => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
