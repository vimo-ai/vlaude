/**
 * @description Data Collector Service - 采集 Claude Code 项目和会话数据
 * @author Claude
 * @date 2025/11/16
 * @version v2.0.0
 *
 * 江湖的业务千篇一律,复杂的代码好几百行。
 * v2.0.0: 核心逻辑抽取到 shared-core 包
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { ServerClientService } from '../server-client/server-client.service';
import {
  encodeProjectPath,
  extractProjectPath,
  getEncodedPrefix,
  scanProjects,
  scanSessions,
  findEncodedDirName,
  findLatestSession,
  readSessionMessages,
  buildSessionPath,
  isValidSessionFile,
  type ClaudeProjectInfo,
  type ClaudeSessionMeta,
  type SessionMessagesResult,
} from '@vimo-ai/vlaude-shared-core';

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
   * 使用 shared-core 的 scanProjects 获取映射
   */
  private async preloadPathCache() {
    try {
      const projects = await scanProjects(this.claudeProjectsPath);
      for (const project of projects) {
        this.pathToEncodedDirCache.set(project.path, project.encodedDirName);
      }
    } catch (error) {
      this.logger.error(`预加载路径映射失败: ${error.message}`);
    }
  }

  /**
   * V2: 刷新指定项目的映射（用于新项目）
   * 使用 shared-core 的 findEncodedDirName
   */
  async refreshProjectMapping(projectPath: string) {
    // 如果缓存已有，验证映射是否有效
    if (this.pathToEncodedDirCache.has(projectPath)) {
      const encodedDirName = this.pathToEncodedDirCache.get(projectPath);
      const projectDir = path.join(this.claudeProjectsPath, encodedDirName!);

      try {
        await fsPromises.access(projectDir);
        return;
      } catch {
        this.logger.warn(`⚠️ 缓存的映射无效，目录不存在: ${projectDir}`);
        this.pathToEncodedDirCache.delete(projectPath);
      }
    }

    try {
      const encodedDirName = await findEncodedDirName(
        this.claudeProjectsPath,
        projectPath,
      );

      if (encodedDirName) {
        this.pathToEncodedDirCache.set(projectPath, encodedDirName);
      } else {
        this.logger.warn(`❌ 未找到项目目录: ${projectPath}`);
      }
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
   * 采集 Claude Code 项目 (V2: 使用 shared-core)
   * @param limit 返回项目数量，不传则返回全部
   * @returns 按最新 session mtime 排序的项目列表
   */
  async collectProjects(limit?: number): Promise<ClaudeProject[]> {
    try {
      const projects = await scanProjects(this.claudeProjectsPath, limit);

      // 同步更新缓存
      for (const project of projects) {
        this.pathToEncodedDirCache.set(project.path, project.encodedDirName);
      }

      return projects;
    } catch (error) {
      this.logger.error(`采集项目失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 采集项目的会话元数据 (V2: 使用 shared-core)
   * @param projectPath 真实的项目路径
   * @param limit 返回会话数量，不传则返回全部
   * @returns 按 mtime 排序的会话元数据列表
   */
  async collectSessions(
    projectPath: string,
    limit?: number,
  ): Promise<ClaudeSession[]> {
    try {
      const encodedDirName = this.getEncodedDirName(projectPath);

      if (!encodedDirName) {
        this.logger.error(`❌ 未找到项目映射: ${projectPath}`);
        return [];
      }

      return await scanSessions(
        this.claudeProjectsPath,
        encodedDirName,
        projectPath,
        limit,
      );
    } catch (error) {
      this.logger.error(`采集会话失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 开始监听指定会话文件（按需监听）
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
   * 读取指定会话的消息内容(支持分页) - V2: 使用 shared-core
   * @param sessionId 会话ID（UUID）
   * @param projectPath 项目路径
   * @param limit 每页条数(默认50)
   * @param offset 偏移量(默认0)
   * @param order 排序方式：'asc' 正序（旧到新），'desc' 倒序（新到旧），默认 'asc'
   */
  async getSessionMessages(
    sessionId: string,
    projectPath: string,
    limit: number = 50,
    offset: number = 0,
    order: 'asc' | 'desc' = 'asc',
  ): Promise<SessionMessagesResult | null> {
    try {
      const encodedDirName = this.getEncodedDirName(projectPath);

      if (!encodedDirName) {
        this.logger.error(`❌ getSessionMessages: 未找到项目映射: ${projectPath}`);
        return null;
      }

      const sessionPath = buildSessionPath(
        this.claudeProjectsPath,
        encodedDirName,
        sessionId,
      );

      return await readSessionMessages(sessionPath, limit, offset, order);
    } catch (error) {
      this.logger.error(`读取会话消息失败 ${sessionId}: ${error.message}`);
      return null;
    }
  }

  /**
   * 查找新创建的 session 文件（带轮询重试）- V2: 使用 shared-core
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
    const maxRetries = 10;
    const retryInterval = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const latestSession = await findLatestSession(
          this.claudeProjectsPath,
          encodedDirName,
          60,
        );

        if (latestSession) {
          await this.serverClient.notifyNewSessionFound(
            clientId,
            latestSession.sessionId,
            projectPath,
            encodedDirName,
          );
          return;
        }

        // 未找到，等待后重试
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryInterval));
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
   * 开始监听项目的新 session 创建 - V2: 使用 shared-core
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
        encodedDirName = encodeProjectPath(projectPath);
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
      const existingFiles = new Set(files.filter(isValidSessionFile));

      // 创建文件监听器
      const watcher = fs.watch(projectDir, async (eventType, filename) => {
        if (filename && isValidSessionFile(filename) && !existingFiles.has(filename)) {
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
