/**
 * @description Data Collector Service - 采集 Claude Code 项目和会话数据
 * @author Claude
 * @date 2025/11/16
 * @version v1.0.0
 *
 * 江湖的业务千篇一律,复杂的代码好几百行。
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { ServerClientService } from '../server-client/server-client.service';

interface ClaudeProject {
  name: string;
  path: string;
  encodedDirName: string;  // 新增:编码的目录名
  lastAccessed: Date;
  sessions: string[];
}

interface ClaudeSession {
  id: string;
  projectPath: string;
  createdAt: Date;
  lastUpdated: Date;
  messageCount: number;
}

interface SessionMetrics {
  connected: boolean;
  mode: string;
  contextLength: number;
  contextPercentage: number;
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
}

@Injectable()
export class DataCollectorService implements OnModuleInit {
  private readonly logger = new Logger(DataCollectorService.name);
  // 修改为真实的 Claude Code 数据路径
  private readonly claudeProjectsPath = path.join(
    process.env.HOME || '~',
    '.claude',
    'projects',
  );

  // 按需监听：sessionId -> { watcher, projectPath, subscriberCount }
  private fileWatchers = new Map<string, { watcher: fs.FSWatcher; projectPath: string; subscriberCount: number }>();

  // 暂停推送的 session（Remote 模式处理中）
  private pausedSessions = new Set<string>();

  // V2: 内存缓存 - 真实路径 → Claude 编码目录名
  private pathToEncodedDirCache = new Map<string, string>();

  // 新 session 监听器：clientId -> { watcher, projectPath }
  private newSessionWatchers = new Map<string, { watcher: fs.FSWatcher; projectPath: string; existingFiles: Set<string> }>();

  constructor(private readonly serverClient: ServerClientService) {
    // 设置 DataCollectorService 到 ServerClientService
    this.serverClient.setDataCollectorService(this);
  }


  async onModuleInit() {
    // V2: 启动时预加载项目路径映射
    await this.preloadPathCache();
  }

  /**
   * V2: 预加载所有项目的路径映射
   * 扫描 Claude 项目目录，建立 真实路径 → 编码目录名 的映射
   */
  private async preloadPathCache() {
    try {
      const dirs = await fsPromises.readdir(this.claudeProjectsPath);

      let count = 0;
      for (const encodedDirName of dirs) {
        const projectDir = path.join(this.claudeProjectsPath, encodedDirName);

        // 检查是否是目录
        const stat = await fsPromises.stat(projectDir);
        if (!stat.isDirectory()) continue;

        // 遍历所有 .jsonl 文件，找到第一个包含 cwd 的文件
        const files = await fsPromises.readdir(projectDir);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

        let realPath: string | null = null;
        for (const jsonlFile of jsonlFiles) {
          realPath = await this.extractProjectPathFromJsonl(
            path.join(projectDir, jsonlFile)
          );
          if (realPath) {
            // 找到了包含 cwd 的文件，停止查找
            break;
          }
        }

        if (realPath) {
          this.pathToEncodedDirCache.set(realPath, encodedDirName);
          count++;
        }
      }
    } catch (error) {
      this.logger.error(`预加载路径映射失败: ${error.message}`);
    }
  }

  /**
   * V2: 刷新指定项目的映射（用于新项目）
   */
  async refreshProjectMapping(projectPath: string) {
    // 如果缓存已有，验证映射是否有效
    if (this.pathToEncodedDirCache.has(projectPath)) {
      const encodedDirName = this.pathToEncodedDirCache.get(projectPath);
      const projectDir = path.join(this.claudeProjectsPath, encodedDirName);

      try {
        await fsPromises.access(projectDir);
        return;
      } catch {
        this.logger.warn(`⚠️ 缓存的映射无效，目录不存在: ${projectDir}`);
        this.pathToEncodedDirCache.delete(projectPath);
      }
    }

    try {
      const dirs = await fsPromises.readdir(this.claudeProjectsPath);
      const projectName = path.basename(projectPath);

      // 计算前缀（到第一个中文字符之前）用于优化过滤
      const prefix = this.getEncodedPrefix(projectPath);

      // 前缀过滤：分离候选目录和跳过的目录
      const candidateDirs: string[] = [];
      const skippedDirs: string[] = [];

      for (const encodedDirName of dirs) {
        const projectDir = path.join(this.claudeProjectsPath, encodedDirName);
        const stat = await fsPromises.stat(projectDir);
        if (!stat.isDirectory()) continue;

        // 前缀匹配：如果前缀完全不同，跳过（性能优化）
        if (prefix && !encodedDirName.startsWith(prefix)) {
          skippedDirs.push(encodedDirName);
          continue;
        }

        candidateDirs.push(encodedDirName);
      }

      let candidateDir: { encodedDirName: string; mtime: Date } | null = null;

      // 扫描候选目录（删除了原有的"跳过已知编码目录"逻辑，以支持多个真实路径映射到同一编码目录）
      for (const encodedDirName of candidateDirs) {
        const projectDir = path.join(this.claudeProjectsPath, encodedDirName);
        const files = await fsPromises.readdir(projectDir);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

        // 遍历所有文件，找到包含 cwd 的文件
        for (const jsonlFile of jsonlFiles) {
          const realPath = await this.extractProjectPathFromJsonl(
            path.join(projectDir, jsonlFile)
          );

          if (realPath === projectPath) {
            this.pathToEncodedDirCache.set(realPath, encodedDirName);
            return;
          }
        }

        // 如果无法从文件中提取 cwd（空文件），尝试通过目录名和最近修改时间匹配
        if (jsonlFiles.length > 0 && encodedDirName.endsWith(`-${projectName}`)) {
          const latestFile = jsonlFiles[0];
          const filePath = path.join(projectDir, latestFile);
          const fileStat = await fsPromises.stat(filePath);
          const now = new Date();
          const ageInSeconds = (now.getTime() - fileStat.mtime.getTime()) / 1000;

          // 如果文件是最近 60 秒内创建的，可能是这个项目
          if (ageInSeconds < 60) {
            if (!candidateDir || fileStat.mtime > candidateDir.mtime) {
              candidateDir = { encodedDirName, mtime: fileStat.mtime };
            }
          }
        }
      }

      // 如果找到候选目录，使用它
      if (candidateDir) {
        this.pathToEncodedDirCache.set(projectPath, candidateDir.encodedDirName);
        return;
      }

      this.logger.warn(`❌ 未找到项目目录: ${projectPath}`);
    } catch (error) {
      this.logger.error(`刷新项目映射失败: ${error.message}`);
    }
  }

  /**
   * V2: 根据真实路径获取编码目录名（纯查表，不扫描）
   */
  private getEncodedDirName(projectPath: string): string | null {
    return this.pathToEncodedDirCache.get(projectPath) || null;
  }

  /**
   * 编码项目路径为 Claude Code 的目录名格式
   * 例如：/Users/xxx/project → -Users-xxx-project
   */
  private encodeProjectPath(realPath: string): string {
    return '-' + realPath.replace(/^\//, '').replace(/\//g, '-');
  }


  /**
   * 采集并发送所有数据
   */
  async collectAndSendData() {
    try {
      // 1. 采集项目数据
      const projects = await this.collectProjects();

      // 2. 发送项目数据到 server
      if (projects.length > 0) {
        await this.serverClient.sendProjectData(projects);
      }

      // 3. 采集会话元数据（V2: 使用 limit 参数 + encodedDirName）
      for (const project of projects) {
        const sessions = await this.collectSessions(project.path, 20); // 最新 20 个会话

        // 4. 发送会话元数据到 server
        if (sessions.length > 0) {
          await this.serverClient.sendSessionMetadata(
            project.path,
            sessions,
          );
        }
      }
    } catch (error) {
      this.logger.error(`数据采集失败: ${error.message}`);
    }
  }

  /**
   * 采集 Claude Code 项目 (V2: 支持 limit 和按 mtime 排序)
   * @param limit 返回项目数量，不传则返回全部
   * @returns 按最新 session mtime 排序的项目列表（只包含轻量级元数据）
   */
  async collectProjects(limit?: number): Promise<ClaudeProject[]> {
    try {
      // 检查 projects 目录是否存在
      try {
        await fsPromises.access(this.claudeProjectsPath);
      } catch {
        this.logger.warn(
          `Claude Code projects 目录不存在: ${this.claudeProjectsPath}`,
        );
        return [];
      }

      const entries = await fsPromises.readdir(this.claudeProjectsPath, {
        withFileTypes: true,
      });
      const projects: ClaudeProject[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const encodedProjectDir = path.join(this.claudeProjectsPath, entry.name);

          try {
            // 读取项目统计信息
            const stats = await fsPromises.stat(encodedProjectDir);

            // 查找会话文件（.jsonl 格式，UUID 命名）
            const sessionEntries = await fsPromises.readdir(encodedProjectDir);
            const sessionFiles = sessionEntries.filter(
              (f) => f.endsWith('.jsonl') && !f.startsWith('agent-'),
            );

            // 找出所有会话文件中最新的修改时间
            let latestMtime = stats.mtime; // 初始值为目录 mtime
            for (const sessionFile of sessionFiles) {
              try {
                const sessionPath = path.join(encodedProjectDir, sessionFile);
                const sessionStats = await fsPromises.stat(sessionPath);
                if (sessionStats.mtime > latestMtime) {
                  latestMtime = sessionStats.mtime;
                }
              } catch (error) {
                this.logger.warn(`读取会话文件 mtime 失败 ${sessionFile}: ${error.message}`);
              }
            }

            // V2: 从 JSONL 文件提取真实项目路径
            let realProjectPath: string | null = null;

            // 遍历所有 .jsonl 文件，找到第一个包含 cwd 的文件
            for (const jsonlFile of sessionFiles) {
              realProjectPath = await this.extractProjectPathFromJsonl(
                path.join(encodedProjectDir, jsonlFile)
              );
              if (realProjectPath) {
                // 找到了包含 cwd 的文件，停止查找
                break;
              }
            }

            // 如果无法从 JSONL 提取，跳过该项目（不再使用解码）
            if (!realProjectPath) {
              continue;
            }

            const projectName = path.basename(realProjectPath);

            projects.push({
              name: projectName,
              path: realProjectPath,
              encodedDirName: entry.name,  // 保存编码的目录名
              lastAccessed: latestMtime,
              sessions: sessionFiles,
            });
          } catch (error) {
            this.logger.error(`处理项目目录失败 ${entry.name}: ${error.message}`);
          }
        }
      }

      // V2 改进: 按最新 session 的 mtime 排序（降序）
      projects.sort((a, b) => b.lastAccessed.getTime() - a.lastAccessed.getTime());

      // 如果指定了 limit，只返回前 N 个
      if (limit && limit > 0) {
        return projects.slice(0, limit);
      }

      return projects;
    } catch (error) {
      this.logger.error(`采集项目失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 采集项目的会话元数据 (V2: 支持 limit，返回轻量级元数据)
   * @param projectPath 真实的项目路径（已解码）
   * @param limit 返回会话数量，不传则返回全部
   * @param encodedDirName 可选的编码目录名(如果提供则直接使用,避免编码错误)
   * @returns 按 mtime 排序的会话元数据列表（不包含消息内容）
   */
  async collectSessions(
    projectPath: string,
    limit?: number,
  ): Promise<ClaudeSession[]> {
    try {
      // V2: 从缓存查找编码目录名
      const encodedDirName = this.getEncodedDirName(projectPath);

      if (!encodedDirName) {
        this.logger.error(`❌ 未找到项目映射: ${projectPath}`);
        return [];
      }

      const encodedProjectDir = path.join(this.claudeProjectsPath, encodedDirName);

      try {
        await fsPromises.access(encodedProjectDir);
      } catch {
        this.logger.warn(`项目目录不存在: ${encodedProjectDir}`);
        return [];
      }

      const sessionFiles = await fsPromises.readdir(encodedProjectDir);

      const sessionMetadata: ClaudeSession[] = [];

      for (const file of sessionFiles) {
        // 只处理会话文件（UUID.jsonl），排除 agent 文件
        if (file.endsWith('.jsonl') && !file.startsWith('agent-')) {
          const sessionPath = path.join(encodedProjectDir, file);
          const sessionId = file.replace(/\.jsonl$/, '');

          try {
            const stats = await fsPromises.stat(sessionPath);

            // V2: 快速统计行数，不解析 JSON（用于增量更新判断）
            const lineCount = await this.countFileLines(sessionPath);

            // 检查是否为 summary 文件（只有一行且 type 为 summary）
            if (lineCount === 1) {
              const firstLine = await this.readFirstLine(sessionPath);
              if (firstLine) {
                try {
                  const entry = JSON.parse(firstLine);
                  if (entry.type === 'summary') {
                    continue; // 跳过 summary 文件
                  }
                } catch {
                  // 解析失败，继续处理
                }
              }
            }

            sessionMetadata.push({
              id: sessionId,
              projectPath,
              createdAt: stats.birthtime,
              lastUpdated: stats.mtime,
              messageCount: lineCount,  // 暂时用行数代替消息数
            });
          } catch (error) {
            this.logger.error(
              `读取会话文件失败 ${file}: ${error.message}`,
            );
          }
        }
      }

      // V2 改进: 按最后更新时间倒序排序
      sessionMetadata.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());

      // 如果指定了 limit，只返回前 N 个
      if (limit && limit > 0) {
        return sessionMetadata.slice(0, limit);
      }

      return sessionMetadata;
    } catch (error) {
      this.logger.error(`采集会话失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 读取文件第一行
   */
  private async readFirstLine(filePath: string): Promise<string | null> {
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      const firstLine = content.split('\n')[0];
      return firstLine?.trim() || null;
    } catch (error) {
      this.logger.error(`读取文件第一行失败 ${filePath}: ${error.message}`);
      return null;
    }
  }

  /**
   * 快速统计文件行数（不读取内容）
   */
  private async countFileLines(filePath: string): Promise<number> {
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      return content.split('\n').filter(line => line.trim()).length;
    } catch (error) {
      this.logger.error(`统计文件行数失败 ${filePath}: ${error.message}`);
      return 0;
    }
  }

  /**
   * 提取路径的编码前缀（到第一个中文字符之前）
   * 用于优化目录扫描性能
   *
   * @example
   * /Users/xxx/小工具/claude/test → -Users-xxx-
   * /Users/xxx/project → -Users-xxx-project
   */
  private getEncodedPrefix(projectPath: string): string {
    // 找到第一个非 ASCII 字符（中文等）的位置
    let prefixEnd = 0;
    for (let i = 0; i < projectPath.length; i++) {
      const char = projectPath[i];
      // 非 ASCII 字符（中文、emoji 等）
      if (char.charCodeAt(0) > 127) {
        break;
      }
      prefixEnd = i + 1;
    }

    // 如果整个路径都是 ASCII，取全路径
    const prefix = projectPath.substring(0, prefixEnd);

    // 转换：/ 替换为 -（Claude Code 的编码规则）
    const encoded = prefix.replace(/\//g, '-');

    return encoded;
  }

  /**
   * 从 JSONL 文件中提取项目路径（使用 grep 命令）
   */
  private async extractProjectPathFromJsonl(jsonlFilePath: string): Promise<string | null> {
    try {
      const { execSync } = require('child_process');

      // 使用 grep 提取 cwd 字段，读取前 10 行
      const result = execSync(`head -n 10 "${jsonlFilePath}" | grep -o '"cwd":"[^"]*"' | head -1`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'], // 忽略 stderr
      }).trim();

      if (result) {
        // 提取引号中的路径：从 "cwd":"/path" 中提取 /path
        const match = result.match(/"cwd":"([^"]+)"/);
        if (match && match[1]) {
          return match[1];
        }
      }

      return null;
    } catch (error) {
      // grep 没找到会返回非 0 退出码，这是正常的
      return null;
    }
  }

  /**
   * 开始监听指定会话文件（按需监听）
   * @param encodedDirName 可选的编码目录名,优先使用避免编码错误
   */
  async startWatchingSession(sessionId: string, projectPath: string) {
    try {
      // 如果已经在监听，增加订阅计数
      const existing = this.fileWatchers.get(sessionId);
      if (existing) {
        existing.subscriberCount++;
        return;
      }

      // V2: 从缓存查找编码目录名
      const encodedDirName = this.getEncodedDirName(projectPath);

      if (!encodedDirName) {
        this.logger.error(`❌ [监听] 未找到项目映射: ${projectPath}`);
        return;
      }

      const encodedProjectDir = path.join(this.claudeProjectsPath, encodedDirName);
      const sessionFilePath = path.join(encodedProjectDir, `${sessionId}.jsonl`);

      // 检查文件是否存在
      try {
        await fsPromises.access(sessionFilePath);
      } catch {
        this.logger.warn(`⚠️ [监听] 会话文件不存在，跳过监听: ${sessionFilePath}`);
        return;
      }

      // 创建文件监听器
      const watcher = fs.watch(sessionFilePath, {
        persistent: true,
      });

      watcher.on('change', async (eventType) => {
        // 处理文件变化
        await this.handleSessionFileChange(projectPath, sessionId);
      });

      watcher.on('error', (error) => {
        this.logger.error(`❌ [监听错误] ${sessionId}: ${error.message}`);
      });

      // 保存监听器
      this.fileWatchers.set(sessionId, {
        watcher,
        projectPath,
        subscriberCount: 1,
      });
    } catch (error) {
      this.logger.error(`❌ [监听失败] ${sessionId}: ${error.message}`);
    }
  }

  /**
   * 停止监听指定会话文件
   */
  async stopWatchingSession(sessionId: string) {
    const existing = this.fileWatchers.get(sessionId);
    if (!existing) {
      this.logger.warn(`⚠️ [停止监听] 会话未在监听中: ${sessionId}`);
      return;
    }

    // 减少订阅计数
    existing.subscriberCount--;

    // 如果没有订阅者了，关闭监听器
    if (existing.subscriberCount <= 0) {
      existing.watcher.close();
      this.fileWatchers.delete(sessionId);
    }
  }

  /**
   * 处理会话文件变化
   */
  private async handleSessionFileChange(projectPath: string, sessionId: string) {
    try {
      // 检查是否在 Remote 模式处理中（暂停推送）
      if (this.pausedSessions.has(sessionId)) {
        return;
      }

      // 读取最新的一条消息
      const result = await this.getSessionMessages(sessionId, projectPath, 1, 0, 'desc');

      if (result && result.messages.length > 0) {
        const latestMessage = result.messages[0];

        // 立即推送消息（不阻塞）
        await this.serverClient.notifyNewMessage(sessionId, latestMessage);

        // 异步推送 metrics（不影响消息推送）
        this.extractAndPushMetrics(sessionId, projectPath).catch(err => {
          this.logger.error(`📊 Metrics 推送失败: ${err.message}`);
        });
      }

      // 更新项目的 lastAccessed 时间
      const encodedDirName = this.getEncodedDirName(projectPath);
      if (!encodedDirName) {
        this.logger.warn(`未找到项目映射: ${projectPath}`);
        return;
      }

      const encodedProjectDir = path.join(this.claudeProjectsPath, encodedDirName);

      try {
        const stats = await fsPromises.stat(encodedProjectDir);

        // 通知 Server 项目已更新
        await this.serverClient.notifyProjectUpdate(projectPath, {
          lastAccessed: stats.mtime,
        });
      } catch (error) {
        this.logger.warn(`读取项目目录失败 ${projectPath}: ${error.message}`);
      }
    } catch (error) {
      this.logger.error(`处理文件变化失败: ${error.message}`);
    }
  }

  /**
   * 公开方法：推送初始 metrics（在 session 订阅时调用）
   */
  async pushInitialMetrics(sessionId: string, projectPath: string): Promise<void> {
    await this.extractAndPushMetrics(sessionId, projectPath);
  }

  /**
   * 异步提取并推送 metrics（不阻塞消息推送）
   */
  private async extractAndPushMetrics(sessionId: string, projectPath: string): Promise<void> {
    try {
      const metrics = await this.extractSessionMetrics(sessionId, projectPath);
      if (metrics) {
        await this.serverClient.notifyMetricsUpdate(sessionId, metrics);
      }
    } catch (error) {
      this.logger.error(`Metrics 推送失败: ${error.message}`);
    }
  }

  /**
   * 从 transcript 提取 metrics
   * 参考 statusline/context.ts 和 tokens.ts 的实现
   * Phase 1: 直接读整个文件（简单可靠）
   */
  private async extractSessionMetrics(sessionId: string, projectPath: string): Promise<SessionMetrics | null> {
    try {
      // 先验证 projectPath 是否在缓存中
      const encodedDirName = this.getEncodedDirName(projectPath);
      if (!encodedDirName) {
        return null;
      }

      // 读取所有消息（正序，从旧到新）
      // 限制最多读取 1000 条消息以避免内存问题
      const result = await this.getSessionMessages(sessionId, projectPath, 1000, 0, 'asc');
      if (!result || result.messages.length === 0) {
        return null;
      }

      // 参考 statusline/context.ts 和 tokens.ts 的实现
      let mostRecentUsage: any = null;
      let mostRecentTimestamp: Date | null = null;
      let totalInput = 0;
      let totalOutput = 0;

      for (const msg of result.messages) {
        const usage = msg.message?.usage;
        if (!usage) continue;

        // 累计所有 token 数量
        totalInput += usage.input_tokens || 0;
        totalOutput += usage.output_tokens || 0;

        // 找最近的 main chain 消息（用于计算 context length）
        if (!msg.isSidechain && !msg.isApiErrorMessage && msg.timestamp) {
          const msgTime = new Date(msg.timestamp);
          if (!mostRecentTimestamp || msgTime > mostRecentTimestamp) {
            mostRecentTimestamp = msgTime;
            mostRecentUsage = usage;
          }
        }
      }

      if (!mostRecentUsage) {
        return null;
      }

      // 计算 context length（input tokens + cache tokens）
      const contextLength =
        (mostRecentUsage.input_tokens || 0) +
        (mostRecentUsage.cache_read_input_tokens || 0) +
        (mostRecentUsage.cache_creation_input_tokens || 0);

      // 计算百分比（基于 200k context window）
      const contextPercentage = (contextLength / 200000) * 100;

      return {
        connected: true,
        mode: 'local',
        contextLength,
        contextPercentage,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`提取 Metrics 失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 读取指定会话的消息内容(支持分页)
   * @param sessionId 会话ID（UUID）
   * @param projectPath 项目路径
   * @param limit 每页条数(默认50)
   * @param offset 偏移量(默认0)
   * @param order 排序方式：'asc' 正序（旧到新），'desc' 倒序（新到旧），默认 'asc'
   * @param encodedDirName 可选的编码目录名
   */
  async getSessionMessages(
    sessionId: string,
    projectPath: string,
    limit: number = 50,
    offset: number = 0,
    order: 'asc' | 'desc' = 'asc',
  ): Promise<{ messages: any[]; total: number; hasMore: boolean } | null> {
    try {
      // V2: 从缓存查找编码目录名
      const encodedDirName = this.getEncodedDirName(projectPath);

      if (!encodedDirName) {
        this.logger.error(`❌ getSessionMessages: 未找到项目映射: ${projectPath}`);
        return null;
      }

      const encodedProjectDir = path.join(this.claudeProjectsPath, encodedDirName);
      const sessionPath = path.join(encodedProjectDir, `${sessionId}.jsonl`);

      try {
        await fsPromises.access(sessionPath);
      } catch {
        this.logger.warn(`会话文件不存在: ${sessionPath}`);
        return null;
      }

      const content = await fsPromises.readFile(sessionPath, 'utf-8');

      // 解析 JSONL 格式
      const allMessages = content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((msg) => msg !== null)
        .filter((msg) => {
          // 过滤 SDK 内部消息类型
          if (!msg.type) return true;

          // 过滤队列操作、快照、摘要等 SDK 内部消息
          const internalTypes = ['queue-operation', 'checkpoint', 'file-history-snapshot', 'summary'];
          return !internalTypes.includes(msg.type);
        });

      const total = allMessages.length;

      // 根据排序方式处理消息顺序
      const sortedMessages = order === 'desc' ? allMessages.reverse() : allMessages;

      // 应用分页
      const messages = sortedMessages.slice(offset, offset + limit);

      return {
        messages,
        total,
        hasMore: offset + messages.length < total,
      };
    } catch (error) {
      this.logger.error(`读取会话消息失败 ${sessionId}: ${error.message}`);
      return null;
    }
  }

  /**
   * 查找新创建的 session 文件（带轮询重试）
   */
  @OnEvent('daemon.findNewSession')
  async handleFindNewSession(data: { clientId: string; projectPath: string }) {
    const { clientId, projectPath } = data;

    // 1. 先检查缓存中是否有映射
    let encodedDirName = this.getEncodedDirName(projectPath);

    // 2. 如果没有映射，刷新映射
    if (!encodedDirName) {
      await this.refreshProjectMapping(projectPath);
      encodedDirName = this.getEncodedDirName(projectPath);
    }

    // 3. 如果还是没有映射，说明项目不存在
    if (!encodedDirName) {
      this.logger.warn(`❌ [查找新Session] 无法找到项目目录`);
      await this.serverClient.notifyNewSessionNotFound(clientId, projectPath);
      return;
    }

    // 4. 有映射了，在该目录下轮询查找最新的 session 文件
    const projectDir = path.join(this.claudeProjectsPath, encodedDirName);
    const maxRetries = 10;
    const retryInterval = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const files = await fsPromises.readdir(projectDir);
        const sessionFiles = files.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
        const now = Date.now();

        let latestSession: { sessionId: string; mtime: number } | null = null;

        for (const file of sessionFiles) {
          const filePath = path.join(projectDir, file);
          const fileStat = await fsPromises.stat(filePath);
          const ageInSeconds = (now - fileStat.mtimeMs) / 1000;

          // 只考虑最近 60 秒内创建的文件
          if (ageInSeconds < 60) {
            const sessionId = path.basename(file, '.jsonl');
            if (!latestSession || fileStat.mtimeMs > latestSession.mtime) {
              latestSession = {
                sessionId,
                mtime: fileStat.mtimeMs,
              };
            }
          }
        }

        if (latestSession) {

          // 通知 Server
          await this.serverClient.notifyNewSessionFound(
            clientId,
            latestSession.sessionId,
            projectPath,
            encodedDirName
          );
          return;
        }

        // 未找到，等待后重试
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryInterval));
        }
      } catch (error) {
        this.logger.error(`❌ [查找新Session] 第 ${attempt} 次尝试失败: ${error.message}`);
        if (attempt === maxRetries) {
          await this.serverClient.notifyNewSessionNotFound(clientId, projectPath);
          return;
        }
      }
    }

    // 所有重试都失败了
    this.logger.warn(`❌ [查找新Session] 未找到新Session (已尝试 ${maxRetries} 次)`);
    await this.serverClient.notifyNewSessionNotFound(clientId, projectPath);
  }

  /**
   * 暂停 session 的推送（Remote 模式处理中）
   */
  @OnEvent('session.pausePush')
  handlePausePush(data: { sessionId: string }) {
    this.pausedSessions.add(data.sessionId);
  }

  /**
   * 恢复 session 的推送
   */
  @OnEvent('session.resumePush')
  handleResumePush(data: { sessionId: string }) {
    this.pausedSessions.delete(data.sessionId);
  }

  /**
   * 开始监听项目的新 session 创建
   */
  @OnEvent('daemon.watchNewSession')
  async handleWatchNewSession(data: { clientId: string; projectPath: string }) {
    const { clientId, projectPath } = data;

    try {
      // 刷新项目映射（如果是新项目）
      await this.refreshProjectMapping(projectPath);

      // 获取编码目录名
      let encodedDirName = this.getEncodedDirName(projectPath);

      // 如果仍然找不到（说明是全新项目），主动创建映射
      if (!encodedDirName) {
        encodedDirName = this.encodeProjectPath(projectPath);
        this.pathToEncodedDirCache.set(projectPath, encodedDirName);
      }

      const projectDir = path.join(this.claudeProjectsPath, encodedDirName);

      // 确保目录存在
      try {
        await fsPromises.access(projectDir);
      } catch {
        // 目录不存在，创建它
        await fsPromises.mkdir(projectDir, { recursive: true });
      }

      // 记录当前已有的 session 文件
      const files = await fsPromises.readdir(projectDir);
      const existingFiles = new Set(files.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-')));

      // 创建文件监听器
      const watcher = fs.watch(projectDir, async (eventType, filename) => {
        if (filename && filename.endsWith('.jsonl') && !filename.startsWith('agent-') && !existingFiles.has(filename)) {
          const sessionId = path.basename(filename, '.jsonl');

          // 停止监听
          watcher.close();
          this.newSessionWatchers.delete(clientId);

          // 通知 Server，Server 再通知 CLI
          await this.serverClient.notifyNewSessionCreated(clientId, sessionId, projectPath);
        }
      });

      // 保存监听器
      this.newSessionWatchers.set(clientId, {
        watcher,
        projectPath,
        existingFiles,
      });

      // 立即通知 CLI 监听器已就绪
      await this.serverClient.notifyWatchStarted(clientId, projectPath);
    } catch (error) {
      this.logger.error(`❌ [监听新Session] 启动失败: ${error.message}`);
    }
  }

  /**
   * 停止监听新 session（可选，用于清理）
   */
  stopWatchingNewSession(clientId: string) {
    const watchInfo = this.newSessionWatchers.get(clientId);
    if (watchInfo) {
      watchInfo.watcher.close();
      this.newSessionWatchers.delete(clientId);
    }
  }

  /**
   * 检查 session 是否在 loading 状态（Claude 正在思考）
   *
   * 判断逻辑：
   * 1. 读取最后一条消息
   * 2. 如果是 assistant 消息且没有 `ts` 字段（完成时间戳），说明正在生成
   * 3. 或者检查文件最近是否被修改（5秒内）
   */
  async isSessionLoading(sessionId: string, projectPath: string): Promise<boolean> {
    try {
      // 获取编码目录名
      const encodedDirName = this.getEncodedDirName(projectPath);
      if (!encodedDirName) {
        this.logger.warn(`[isSessionLoading] 未找到项目映射: ${projectPath}`);
        return false;
      }

      const encodedProjectDir = path.join(this.claudeProjectsPath, encodedDirName);
      const sessionPath = path.join(encodedProjectDir, `${sessionId}.jsonl`);

      // 检查文件是否存在
      try {
        await fsPromises.access(sessionPath);
      } catch {
        this.logger.warn(`[isSessionLoading] 文件不存在: ${sessionPath}`);
        return false;
      }

      // 读取最后一条消息
      const result = await this.getSessionMessages(sessionId, projectPath, 1, 0, 'desc');
      if (!result || result.messages.length === 0) {
        return false;
      }

      const lastMessage = result.messages[0];

      // 检查是否是 assistant 消息且正在生成
      if (lastMessage.role === 'assistant') {
        // 如果没有 ts 字段（完成时间戳），说明正在生成
        if (!lastMessage.ts) {
          return true;
        }
      }

      // 检查文件最近是否被修改（5秒内认为可能在 loading）
      const stats = await fsPromises.stat(sessionPath);
      const ageInMs = Date.now() - stats.mtimeMs;
      if (ageInMs < 5000) {
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error(`[isSessionLoading] 检查失败: ${error.message}`);
      return false;
    }
  }
}
