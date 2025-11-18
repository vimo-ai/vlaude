import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Claude Code 进程信息
 */
export interface ClaudeProcessInfo {
  pid: number;
  command: string;
  workingDirectory: string;
  startTime: Date;
}

/**
 * Process Manager Service
 * 管理 Claude Code 进程的监控和控制
 */
@Injectable()
export class ProcessManagerService {
  private readonly logger = new Logger(ProcessManagerService.name);
  private monitoredProcesses = new Map<number, ClaudeProcessInfo>();
  private monitorInterval: NodeJS.Timeout | null = null;

  /**
   * 启动进程监控
   */
  startMonitoring(intervalMs: number = 5000) {
    if (this.monitorInterval) {
      this.logger.warn('Process monitoring already started');
      return;
    }

    this.logger.log(`Starting process monitoring (interval: ${intervalMs}ms)`);

    // 立即执行一次扫描
    this.scanClaudeProcesses();

    // 定期扫描
    this.monitorInterval = setInterval(() => {
      this.scanClaudeProcesses();
    }, intervalMs);
  }

  /**
   * 停止进程监控
   */
  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      this.logger.log('Process monitoring stopped');
    }
  }

  /**
   * 扫描 Claude Code 进程
   */
  private async scanClaudeProcesses() {
    try {
      // 在 macOS 上查找 Claude Code 进程
      // 注意: Claude Code 可能以不同的进程名运行,需要根据实际情况调整
      const { stdout } = await execAsync(
        'ps aux | grep -i "claude" | grep -v grep || true',
      );

      const lines = stdout.trim().split('\n').filter(line => line.length > 0);
      const currentPids = new Set<number>();

      for (const line of lines) {
        const match = this.parseProcessLine(line);
        if (match) {
          currentPids.add(match.pid);

          // 如果是新进程,记录下来
          if (!this.monitoredProcesses.has(match.pid)) {
            this.monitoredProcesses.set(match.pid, match);
            this.logger.log(`New Claude process detected: PID ${match.pid}`);
            this.onProcessStarted(match);
          }
        }
      }

      // 检查已终止的进程
      for (const [pid, info] of this.monitoredProcesses.entries()) {
        if (!currentPids.has(pid)) {
          this.logger.log(`Claude process terminated: PID ${pid}`);
          this.onProcessTerminated(info);
          this.monitoredProcesses.delete(pid);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to scan processes: ${error.message}`);
    }
  }

  /**
   * 解析进程信息行
   */
  private parseProcessLine(line: string): ClaudeProcessInfo | null {
    try {
      // ps aux 格式: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) return null;

      const pid = parseInt(parts[1], 10);
      if (isNaN(pid)) return null;

      const command = parts.slice(10).join(' ');

      // 过滤掉非 Claude Code 相关的进程
      if (!this.isClaudeCodeProcess(command)) {
        return null;
      }

      return {
        pid,
        command,
        workingDirectory: '', // 后续可以通过 lsof 获取
        startTime: new Date(), // 后续可以从 ps -p 获取准确时间
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 判断是否是 Claude Code 进程
   */
  private isClaudeCodeProcess(command: string): boolean {
    // 根据实际的 Claude Code 进程特征进行判断
    // 这里先用简单的关键词匹配,后续需要根据实际情况调整
    const keywords = ['claude', 'anthropic', 'code-agent'];
    return keywords.some(keyword => command.toLowerCase().includes(keyword));
  }

  /**
   * 进程启动回调
   */
  private onProcessStarted(info: ClaudeProcessInfo) {
    // 后续可以触发会话扫描,连接到进程等操作
    this.logger.debug(`Process started handler: PID ${info.pid}`);
  }

  /**
   * 进程终止回调
   */
  private onProcessTerminated(info: ClaudeProcessInfo) {
    // 后续可以清理相关资源,更新会话状态等
    this.logger.debug(`Process terminated handler: PID ${info.pid}`);
  }

  /**
   * 获取当前监控的进程列表
   */
  getMonitoredProcesses(): ClaudeProcessInfo[] {
    return Array.from(this.monitoredProcesses.values());
  }

  /**
   * 获取指定 PID 的进程信息
   */
  getProcessInfo(pid: number): ClaudeProcessInfo | undefined {
    return this.monitoredProcesses.get(pid);
  }

  /**
   * 检查是否有活跃的 Claude Code 进程
   */
  hasActiveProcesses(): boolean {
    return this.monitoredProcesses.size > 0;
  }
}
