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
    this.logger.log('📦 DataCollectorService 初始化完成');
    this.logger.log(`📁 Claude Projects 路径: ${this.claudeProjectsPath}`);

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
        this.logger.debug(`项目已在缓存中且目录有效: ${projectPath} → ${encodedDirName}`);
        return;
      } catch {
        this.logger.warn(`⚠️ 缓存的映射无效，目录不存在: ${projectDir}`);
        this.logger.log(`🗑️ 清除无效缓存，重新扫描`);
        this.pathToEncodedDirCache.delete(projectPath);
      }
    }

    this.logger.log(`🔍 扫描新项目: ${projectPath}`);

    try {
      const dirs = await fsPromises.readdir(this.claudeProjectsPath);
      const projectName = path.basename(projectPath);

      // 计算前缀（到第一个中文字符之前）用于优化过滤
      const prefix = this.getEncodedPrefix(projectPath);
      this.logger.debug(`计算编码前缀: ${projectPath} → ${prefix || '(无前缀)'}`);

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

      this.logger.debug(`前缀匹配结果: ${candidateDirs.length} 个候选目录, ${skippedDirs.length} 个跳过`);

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
            this.logger.log(`✅ 新项目已加入缓存: ${projectPath} → ${encodedDirName}`);
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
        this.logger.log(`✅ 通过目录名和时间匹配找到项目: ${projectPath} → ${candidateDir.encodedDirName}`);
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
      this.logger.log('开始采集 Claude Code 数据...');

      // 1. 采集项目数据
      const projects = await this.collectProjects();
      this.logger.log(`采集到 ${projects.length} 个项目`);

      // 2. 发送项目数据到 server
      if (projects.length > 0) {
        await this.serverClient.sendProjectData(projects);
      }

      // 3. 采集会话元数据（V2: 使用 limit 参数 + encodedDirName）
      for (const project of projects) {
        const sessions = await this.collectSessions(project.path, 20); // 最新 20 个会话
        this.logger.log(`项目 ${project.name} 有 ${sessions.length} 个会话`);

        // 4. 发送会话元数据到 server
        if (sessions.length > 0) {
          await this.serverClient.sendSessionMetadata(
            project.path,
            sessions,
          );
        }
      }

      this.logger.log('数据采集完成');
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
              this.logger.warn(`⚠️ 无法从 JSONL 提取项目路径，跳过: ${entry.name}`);
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

            this.logger.debug(`发现项目: ${projectName} (路径: ${realProjectPath}, 会话: ${sessionFiles.length}, 最后访问: ${latestMtime.toISOString()})`);
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
      const startTime = Date.now();

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

      const t1 = Date.now();
      const sessionFiles = await fsPromises.readdir(encodedProjectDir);
      this.logger.log(`⏱️ [collectSessions] readdir 耗时: ${Date.now() - t1}ms, 文件数: ${sessionFiles.length}`);

      const sessionMetadata: ClaudeSession[] = [];

      // V2 改进: 只采集元数据（mtime, fileSize, lineCount），不读取文件内容
      const t2 = Date.now();
      let statCount = 0;
      let lineCountTime = 0;

      for (const file of sessionFiles) {
        // 只处理会话文件（UUID.jsonl），排除 agent 文件
        if (file.endsWith('.jsonl') && !file.startsWith('agent-')) {
          const sessionPath = path.join(encodedProjectDir, file);
          const sessionId = file.replace(/\.jsonl$/, '');

          try {
            const stats = await fsPromises.stat(sessionPath);
            statCount++;

            // V2: 快速统计行数，不解析 JSON（用于增量更新判断）
            const tLineCount = Date.now();
            const lineCount = await this.countFileLines(sessionPath);
            lineCountTime += Date.now() - tLineCount;

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

      this.logger.log(`⏱️ [collectSessions] 处理文件耗时: ${Date.now() - t2}ms (stat: ${statCount}次, lineCount总计: ${lineCountTime}ms)`);

      // V2 改进: 按最后更新时间倒序排序
      const t3 = Date.now();
      sessionMetadata.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());
      this.logger.log(`⏱️ [collectSessions] 排序耗时: ${Date.now() - t3}ms`);

      // 如果指定了 limit，只返回前 N 个
      if (limit && limit > 0) {
        const result = sessionMetadata.slice(0, limit);
        this.logger.log(`⏱️ [collectSessions] 总耗时: ${Date.now() - startTime}ms, 返回 ${result.length} 个会话`);
        return result;
      }

      this.logger.log(`⏱️ [collectSessions] 总耗时: ${Date.now() - startTime}ms, 返回 ${sessionMetadata.length} 个会话`);
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
        this.logger.log(`📌 [监听] 会话已在监听中，订阅数 +1: ${sessionId} (订阅数: ${existing.subscriberCount})`);
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
        this.logger.log(`🔔 [文件变化] ${eventType} - ${sessionId}`);
        this.logger.log(`📄 文件路径: ${sessionFilePath}`);

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

      this.logger.log(`✅ [开始监听] 会话: ${sessionId}`);
      this.logger.log(`   项目: ${projectPath}`);
      this.logger.log(`   文件: ${sessionFilePath}`);
      this.logger.log(`   当前活跃监听数: ${this.fileWatchers.size}`);
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
    this.logger.log(`📌 [停止监听] 订阅数 -1: ${sessionId} (剩余订阅数: ${existing.subscriberCount})`);

    // 如果没有订阅者了，关闭监听器
    if (existing.subscriberCount <= 0) {
      existing.watcher.close();
      this.fileWatchers.delete(sessionId);
      this.logger.log(`🛑 [关闭监听] 会话: ${sessionId}`);
      this.logger.log(`   当前活跃监听数: ${this.fileWatchers.size}`);
    }
  }

  /**
   * 处理会话文件变化
   */
  private async handleSessionFileChange(projectPath: string, sessionId: string) {
    try {
      // 检查是否在 Remote 模式处理中（暂停推送）
      if (this.pausedSessions.has(sessionId)) {
        this.logger.log(`⏸️  [跳过推送] Session 在 Remote 模式处理中: ${sessionId}`);
        return;
      }

      // 读取最新的一条消息
      const result = await this.getSessionMessages(sessionId, projectPath, 1, 0, 'desc');

      if (result && result.messages.length > 0) {
        const latestMessage = result.messages[0];

        this.logger.log(`📨 检测到新消息: ${sessionId}`);

        // 通知 Server 推送新消息
        await this.serverClient.notifyNewMessage(sessionId, latestMessage);
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

    this.logger.log(`🔍 [查找新Session] 开始查找: clientId=${clientId}`);
    this.logger.log(`   项目路径: ${projectPath}`);

    // 1. 先检查缓存中是否有映射
    let encodedDirName = this.getEncodedDirName(projectPath);

    // 2. 如果没有映射，刷新映射
    if (!encodedDirName) {
      this.logger.log(`🔄 [查找新Session] 缓存中无映射，刷新中...`);
      await this.refreshProjectMapping(projectPath);
      encodedDirName = this.getEncodedDirName(projectPath);
    } else {
      this.logger.log(`✅ [查找新Session] 使用缓存映射: ${encodedDirName}`);
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
        this.logger.debug(`🔍 [查找新Session] 第 ${attempt} 次尝试，目录: ${encodedDirName}`);

        const files = await fsPromises.readdir(projectDir);
        const sessionFiles = files.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
        const now = Date.now();

        this.logger.debug(`   Session 文件数: ${sessionFiles.length}`);

        let latestSession: { sessionId: string; mtime: number } | null = null;

        for (const file of sessionFiles) {
          const filePath = path.join(projectDir, file);
          const fileStat = await fsPromises.stat(filePath);
          const ageInSeconds = (now - fileStat.mtimeMs) / 1000;

          this.logger.debug(`   文件: ${file}, 创建于 ${ageInSeconds.toFixed(1)} 秒前`);

          // 只考虑最近 60 秒内创建的文件
          if (ageInSeconds < 60) {
            const sessionId = path.basename(file, '.jsonl');
            if (!latestSession || fileStat.mtimeMs > latestSession.mtime) {
              latestSession = {
                sessionId,
                mtime: fileStat.mtimeMs,
              };
              this.logger.debug(`   ✅ 候选: ${sessionId}`);
            }
          } else {
            this.logger.debug(`   ⏭️  跳过（超过60秒）`);
          }
        }

        if (latestSession) {
          this.logger.log(`✅ [查找新Session] 找到了: ${latestSession.sessionId} (第 ${attempt} 次尝试)`);
          this.logger.log(`   目录: ${encodedDirName}`);

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
          this.logger.debug(`🔄 [查找新Session] 未找到，等待 ${retryInterval}ms 后重试 (${attempt}/${maxRetries})`);
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
    this.logger.log(`⏸️  [暂停推送] Session: ${data.sessionId}`);
  }

  /**
   * 恢复 session 的推送
   */
  @OnEvent('session.resumePush')
  handleResumePush(data: { sessionId: string }) {
    this.pausedSessions.delete(data.sessionId);
    this.logger.log(`▶️  [恢复推送] Session: ${data.sessionId}`);
  }

  /**
   * 开始监听项目的新 session 创建
   */
  @OnEvent('daemon.watchNewSession')
  async handleWatchNewSession(data: { clientId: string; projectPath: string }) {
    const { clientId, projectPath } = data;

    this.logger.log(`👀 [监听新Session] 开始监听: clientId=${clientId}`);
    this.logger.log(`   项目路径: ${projectPath}`);

    try {
      // 刷新项目映射（如果是新项目）
      await this.refreshProjectMapping(projectPath);

      // 获取编码目录名
      let encodedDirName = this.getEncodedDirName(projectPath);

      // 如果仍然找不到（说明是全新项目），主动创建映射
      if (!encodedDirName) {
        this.logger.log(`🆕 [监听新Session] 创建新项目映射: ${projectPath}`);
        encodedDirName = this.encodeProjectPath(projectPath);
        this.pathToEncodedDirCache.set(projectPath, encodedDirName);
        this.logger.log(`   编码目录名: ${encodedDirName}`);
      }

      const projectDir = path.join(this.claudeProjectsPath, encodedDirName);

      // 确保目录存在
      try {
        await fsPromises.access(projectDir);
      } catch {
        // 目录不存在，创建它
        await fsPromises.mkdir(projectDir, { recursive: true });
        this.logger.log(`📁 [监听新Session] 创建项目目录: ${projectDir}`);
      }

      // 记录当前已有的 session 文件
      const files = await fsPromises.readdir(projectDir);
      const existingFiles = new Set(files.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-')));

      this.logger.log(`   当前已有 ${existingFiles.size} 个 session 文件`);

      // 创建文件监听器
      const watcher = fs.watch(projectDir, async (eventType, filename) => {
        if (filename && filename.endsWith('.jsonl') && !filename.startsWith('agent-') && !existingFiles.has(filename)) {
          const sessionId = path.basename(filename, '.jsonl');
          this.logger.log(`🆕 [检测到新Session] ${sessionId}`);
          this.logger.log(`   文件: ${filename}`);

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

      this.logger.log(`✅ [监听新Session] 监听器已启动`);

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
      this.logger.log(`🛑 [停止监听新Session] clientId=${clientId}`);
    }
  }
}
