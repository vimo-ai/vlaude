/**
 * @description Session Service - 会话数据管理
 * @author Claude
 * @date 2025/11/16
 * @version v2.0.0
 *
 * V2 架构改进:
 * 1. 数据优先级: 文件系统 > 数据库
 * 2. 增量解析策略: 对比 mtime 和 lineCount，只解析新增内容
 * 3. 数据库作为缓存，用于加速查询
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

interface MessageData {
  role: string;
  content: string;
  timestamp?: Date;
  [key: string]: any;
}

// Daemon 返回的轻量级会话元数据
interface DaemonSessionMetadata {
  sessionId: string;
  projectPath: string;
  lastMtime: string;  // ISO 格式的时间字符串
  createdAt: string;
  lineCount: number;  // 文件总行数
  lastMessage?: any;  // Daemon 返回的最后一条消息(可选)
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly daemonBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => require('../daemon-gateway/daemon.gateway').DaemonGateway))
    private readonly daemonGateway: any,
  ) {
    // 从环境变量读取 Daemon 地址
    const daemonPort = this.config.get<number>('DAEMON_PORT', 10006);
    this.daemonBaseUrl = `http://localhost:${daemonPort}`;
  }

  /**
   * 批量保存会话元数据（不保存完整消息内容）
   */
  async saveSessionMetadata(
    projectPath: string,
    sessions: Array<{
      id: string;
      createdAt: Date;
      lastUpdated: Date;
      messageCount: number;
    }>,
  ) {
    this.logger.log(
      `批量保存会话元数据，项目: ${projectPath}，会话数: ${sessions.length}`,
    );

    try {
      // 先查找或创建项目
      let project = await this.prisma.project.findUnique({
        where: { path: projectPath },
      });

      if (!project) {
        // 如果项目不存在，创建一个占位项目
        const projectName = projectPath.split('/').pop() || 'Unknown';
        project = await this.prisma.project.create({
          data: {
            name: projectName,
            path: projectPath,
            lastAccessed: new Date(),
          },
        });
        this.logger.debug(`自动创建项目: ${projectName}`);
      }

      // 批量更新或创建会话（只保存元数据）
      const results = await Promise.all(
        sessions.map((session) =>
          this.prisma.session.upsert({
            where: {
              sessionId: session.id,
            },
            update: {
              messageCount: session.messageCount,
              lastMessageAt: session.lastUpdated,
              updatedAt: new Date(),
            },
            create: {
              sessionId: session.id,
              projectId: project.id,
              messageCount: session.messageCount,
              lastMessageAt: session.lastUpdated,
              createdAt: session.createdAt,
            },
          }),
        ),
      );

      this.logger.debug(`批量保存完成: ${results.length} 个会话元数据`);
      return results;
    } catch (error) {
      this.logger.error(`批量保存会话元数据失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 保存会话数据（保留此方法用于需要保存完整消息的场景）
   */
  async saveSession(
    sessionId: string,
    projectPath: string,
    messages: MessageData[],
  ) {
    this.logger.log(
      `保存会话 ${sessionId}，包含 ${messages.length} 条消息`,
    );

    try {
      // 先查找或创建项目
      let project = await this.prisma.project.findUnique({
        where: { path: projectPath },
      });

      if (!project) {
        // 如果项目不存在，创建一个占位项目
        const projectName = projectPath.split('/').pop() || 'Unknown';
        project = await this.prisma.project.create({
          data: {
            name: projectName,
            path: projectPath,
            lastAccessed: new Date(),
          },
        });
        this.logger.debug(`自动创建项目: ${projectName}`);
      }

      // 保存或更新会话
      const session = await this.prisma.session.upsert({
        where: {
          sessionId,
        },
        update: {
          messageCount: messages.length,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        },
        create: {
          sessionId,
          projectId: project.id,
          messageCount: messages.length,
          lastMessageAt: new Date(),
        },
      });

      // 删除旧消息
      await this.prisma.message.deleteMany({
        where: {
          sessionId: session.id,
        },
      });

      // 批量插入新消息
      if (messages.length > 0) {
        await this.prisma.message.createMany({
          data: messages.map((msg, index) => ({
            sessionId: session.id,
            role: msg.role,
            content: msg.content,
            metadata: msg as any, // 存储完整的消息数据
            sequence: index,
            timestamp: msg.timestamp || new Date(),
          })),
        });
      }

      this.logger.debug(`会话已保存: ${sessionId}，消息数: ${messages.length}`);
      return session;
    } catch (error) {
      this.logger.error(`保存会话失败 ${sessionId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取会话详情
   */
  async getSessionById(id: number) {
    return this.prisma.session.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: {
            sequence: 'asc',
          },
        },
        project: true,
      },
    });
  }

  /**
   * 根据 sessionId 获取会话
   */
  async getSessionBySessionId(sessionId: string) {
    return this.prisma.session.findUnique({
      where: { sessionId },
      include: {
        messages: {
          orderBy: {
            sequence: 'asc',
          },
        },
        project: true,
      },
    });
  }

  /**
   * 创建新对话
   * @param projectPath 项目路径
   * @param prompt 可选的初始提示词
   * @returns 创建的 session 数据
   */
  async createSession(projectPath: string, prompt?: string) {
    this.logger.log(`📝 创建新对话，projectPath=${projectPath}`);

    try {
      // 1. 调用 Daemon API 创建 session
      const daemonResult = await this.createSessionInDaemon(projectPath, prompt);

      if (!daemonResult.success) {
        throw new Error(daemonResult.message || '调用 Daemon 创建 session 失败');
      }

      const { sessionId, encodedDirName, transcriptPath } = daemonResult.data;
      this.logger.log(`✅ Daemon 创建成功，sessionId=${sessionId}`);

      // 2. 查找或创建 Project 记录
      let project = await this.prisma.project.findUnique({
        where: { path: projectPath },
      });

      if (!project) {
        // 如果项目不存在，创建一个新的
        const projectName = projectPath.split('/').pop() || 'Unknown';
        project = await this.prisma.project.create({
          data: {
            name: projectName,
            path: projectPath,
            encodedDirName,
            projectPath, // 兼容字段
          },
        });
        this.logger.log(`📁 创建新项目记录: ${projectName}`);
      }

      // 3. 创建 Session 记录
      const session = await this.prisma.session.create({
        data: {
          sessionId,
          projectId: project.id,
          projectPath,
          messageCount: 0,
          lastParsedLine: 0,
          lastFileSize: BigInt(0),
        },
        include: {
          project: true,
        },
      });

      this.logger.log(`✅ Session 记录已创建: ${sessionId}`);

      return session;
    } catch (error) {
      this.logger.error(`❌ 创建对话失败: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * 调用 Daemon API 创建 session
   */
  private async createSessionInDaemon(projectPath: string, prompt?: string) {
    const url = `${this.daemonBaseUrl}/sessions`;
    this.logger.debug(`🔗 调用 Daemon API: POST ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectPath, prompt }),
    });

    if (!response.ok) {
      throw new Error(`Daemon API 返回错误: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * 获取项目的会话列表 (V2: 从文件系统获取 + 增量更新数据库 + 分页支持)
   * @param projectPath 项目路径
   * @param limit 返回会话数量，默认 20
   * @param offset 偏移量，默认 0
   * @returns 按最新 mtime 排序的会话列表 + 分页信息
   */
  async getSessionsByProjectPath(projectPath: string, limit: number = 20, offset: number = 0) {
    try {
      this.logger.log(`📋 获取会话列表，projectPath=${projectPath}, limit=${limit}, offset=${offset}`);

      // 阶段 1: 快速响应 - 立即从数据库返回缓存（<50ms）
      const project = await this.prisma.project.findUnique({
        where: { path: projectPath },
      });

      if (!project) {
        this.logger.warn(`项目不存在: ${projectPath}`);
        return { sessions: [], total: 0, hasMore: false };
      }

      const cachedSessions = await this.prisma.session.findMany({
        where: {
          projectId: project.id,
          isDeleted: false,
        },
        orderBy: {
          lastMtime: 'desc',
        },
        skip: offset,
        take: limit,
        include: {
          messages: {
            where: { sequence: 0 }, // sequence = 0 是缓存的 lastMessage
            take: 1,
          },
        },
      });

      const total = await this.prisma.session.count({
        where: { projectId: project.id, isDeleted: false },
      });
      const hasMore = offset + cachedSessions.length < total;

      // 格式化缓存数据
      const sessionsWithLastMessage = cachedSessions.map(session => ({
        ...session,
        messages: undefined,
        lastMessage: session.messages?.[0]?.metadata || null,
      }));

      this.logger.log(`⚡ 快速返回缓存: ${sessionsWithLastMessage.length} 个会话 (total=${total})`);

      // 阶段 2: 后台刷新（不阻塞响应）
      setImmediate(() => {
        this.refreshSessionsInBackground(projectPath, limit, offset).catch(error => {
          this.logger.error(`后台刷新失败: ${error.message}`);
        });
      });

      return { sessions: sessionsWithLastMessage, total, hasMore };

    } catch (error) {
      this.logger.error(`获取会话列表失败: ${error.message}`);
      // 降级方案：从数据库读取
      const project = await this.prisma.project.findUnique({
        where: { path: projectPath },
      });

      if (!project) {
        return { sessions: [], total: 0, hasMore: false };
      }

      const sessions = await this.prisma.session.findMany({
        where: {
          projectId: project.id,
          isDeleted: false,
        },
        orderBy: { lastMtime: 'desc' },
        skip: offset,
        take: limit,
        include: {
          messages: {
            orderBy: { sequence: 'desc' },
            take: 1,
          },
        },
      });
      const total = await this.prisma.session.count({
        where: { projectId: project.id, isDeleted: false },
      });
      const hasMore = offset + sessions.length < total;
      return { sessions, total, hasMore };
    }
  }

  /**
   * 后台刷新会话列表（异步，不阻塞响应）
   */
  private async refreshSessionsInBackground(projectPath: string, limit: number, offset: number) {
    try {
      this.logger.debug(`🔄 开始后台刷新会话列表: ${projectPath}`);

      // 1. 从 Daemon 获取文件系统的会话元数据
      const daemonSessions = await this.fetchSessionsFromDaemon(projectPath, limit, offset);

      if (daemonSessions.length === 0) {
        this.logger.debug('后台刷新: Daemon 未返回任何会话');
        return;
      }

      this.logger.debug(`📦 后台刷新: Daemon 返回 ${daemonSessions.length} 个会话`);

      // 2. 增量更新策略：对比 mtime 和 lineCount，识别新/旧会话
      const { newSessions, unchangedSessions } = await this.categorizeSessions(daemonSessions);

      this.logger.debug(`🆕 后台刷新: 新会话 ${newSessions.length} 个, 未变化 ${unchangedSessions.length} 个`);

      // 3. 如果有新会话，更新数据库缓存
      if (newSessions.length > 0) {
        // 获取最后一条消息
        await this.fetchLastMessagesForSessions(newSessions, projectPath);

        // 更新数据库缓存
        await this.updateSessionCache(newSessions, projectPath);

        // 通过 WebSocket 推送更新通知
        this.eventEmitter.emit('app.notifySessionUpdate', {
          sessionId: 'list-updated',  // 标记为列表更新
          metadata: {
            projectPath,
            updatedCount: newSessions.length,
            sessions: newSessions.map(s => s.sessionId),
          },
        });

        this.logger.log(`✅ 后台刷新完成: 更新了 ${newSessions.length} 个会话，已推送 WebSocket 通知`);
      } else {
        this.logger.debug(`✅ 后台刷新完成: 无变化`);
      }

    } catch (error) {
      this.logger.error(`后台刷新会话列表失败: ${error.message}`);
    }
  }

  /**
   * 从 Daemon 获取会话元数据
   * V2: 只传递 projectPath，Daemon 内部查表
   */
  private async fetchSessionsFromDaemon(projectPath: string, limit: number, offset: number = 0): Promise<DaemonSessionMetadata[]> {
    try {
      const url = `${this.daemonBaseUrl}/sessions?projectPath=${encodeURIComponent(projectPath)}&limit=${limit}&offset=${offset}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Daemon API 返回错误: ${response.status}`);
      }

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.message || 'Daemon 返回失败');
      }

      return result.data || [];
    } catch (error) {
      this.logger.error(`调用 Daemon API 失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 为 mtime 变化的会话获取最后一条消息
   */
  private async fetchLastMessagesForSessions(sessions: DaemonSessionMetadata[], projectPath: string) {
    this.logger.log(`📨 开始获取 ${sessions.length} 个会话的最后一条消息`);

    // 并发获取所有会话的最后一条消息
    await Promise.all(
      sessions.map(async (session) => {
        try {
          // 调用 Daemon API 获取最后一条消息
          const result = await this.daemonGateway.requestSessionMessages(
            session.sessionId,
            projectPath,
            1,    // limit: 只要1条
            0,    // offset: 0
            'desc', // order: 倒序，获取最后一条
          );

          if (result?.messages?.[0]) {
            // 将最后一条消息附加到 session 对象上
            session.lastMessage = result.messages[0];
          }
        } catch (error) {
          this.logger.error(`获取会话 ${session.sessionId} 的最后一条消息失败: ${error.message}`);
        }
      })
    );

    this.logger.log(`✅ 已获取 ${sessions.filter(s => s.lastMessage).length} 个会话的最后一条消息`);
  }

  /**
   * 分类会话：识别新会话和未变化会话 (3新7旧策略)
   */
  private async categorizeSessions(daemonSessions: DaemonSessionMetadata[]) {
    const newSessions: DaemonSessionMetadata[] = [];
    const unchangedSessions: DaemonSessionMetadata[] = [];

    // ⚠️ 性能优化：批量查询所有会话，避免 N+1 问题
    const sessionIds = daemonSessions.map(s => s.sessionId);
    const t1 = Date.now();
    const dbSessions = await this.prisma.session.findMany({
      where: { sessionId: { in: sessionIds } },
    });
    this.logger.log(`⏱️ [categorizeSessions] 批量查询 ${sessionIds.length} 个会话耗时: ${Date.now() - t1}ms`);

    // 创建 sessionId -> dbSession 的映射
    const dbSessionMap = new Map(dbSessions.map(s => [s.sessionId, s]));

    for (const daemonSession of daemonSessions) {
      // 从 Map 中查询该会话（O(1) 时间复杂度）
      const dbSession = dbSessionMap.get(daemonSession.sessionId);

      const daemonMtime = new Date(daemonSession.lastMtime);

      if (!dbSession) {
        // 数据库中不存在 → 新会话
        newSessions.push(daemonSession);
      } else if (!dbSession.lastMtime || dbSession.lastMtime < daemonMtime || dbSession.lastParsedLine < daemonSession.lineCount) {
        // mtime 更新了 或 行数增加了 → 有新消息，需要增量更新
        newSessions.push(daemonSession);
      } else {
        // mtime 和行数都没变 → 使用数据库缓存
        unchangedSessions.push(daemonSession);
      }
    }

    return { newSessions, unchangedSessions };
  }

  /**
   * 更新数据库缓存 (只更新变化的会话，不解析消息)
   * 优化：使用并发批量操作，大幅提升性能
   */
  private async updateSessionCache(sessions: DaemonSessionMetadata[], projectPath: string) {
    // 先查找或创建项目
    let project = await this.prisma.project.findUnique({
      where: { path: projectPath },
    });

    if (!project) {
      const projectName = projectPath.split('/').pop() || 'Unknown';
      project = await this.prisma.project.create({
        data: {
          name: projectName,
          path: projectPath,
          lastModified: new Date(),
        },
      });
    }

    // ⚡ 性能优化：并发处理所有会话，而不是串行
    await Promise.all(
      sessions.map(async (session) => {
        try {
          // 1. 更新或创建会话记录
          const dbSession = await this.prisma.session.upsert({
            where: { sessionId: session.sessionId },
            update: {
              projectPath,
              messageCount: session.lineCount,
              lastMtime: new Date(session.lastMtime),
              lastParsedLine: session.lineCount,
              updatedAt: new Date(),
            },
            create: {
              sessionId: session.sessionId,
              projectId: project.id,
              projectPath,
              messageCount: session.lineCount,
              lastMtime: new Date(session.lastMtime),
              createdAt: new Date(session.createdAt),
              lastParsedLine: session.lineCount,
              lastFileSize: BigInt(0),
            },
          });

          // 2. 存储最后一条消息到缓存
          const lastMessage = session.lastMessage;
          if (lastMessage) {
            const role = lastMessage.message?.role || lastMessage.type || 'unknown';
            const timestamp = new Date(lastMessage.timestamp || Date.now());

            await this.prisma.message.upsert({
              where: {
                sessionId_sequence: {
                  sessionId: dbSession.id,
                  sequence: 0,
                },
              },
              update: {
                role,
                content: '',
                timestamp,
                metadata: lastMessage,
              },
              create: {
                sessionId: dbSession.id,
                role,
                content: '',
                sequence: 0,
                timestamp,
                metadata: lastMessage,
              },
            });
          }
        } catch (error) {
          this.logger.error(`更新会话缓存失败 ${session.sessionId}: ${error.message}`);
        }
      })
    );
  }

  /**
   * 获取项目的所有会话 (旧方法，保留向后兼容)
   */
  async getSessionsByProject(projectId: number) {
    return this.prisma.session.findMany({
      where: {
        projectId,
      },
      orderBy: {
        lastMessageAt: 'desc',
      },
      include: {
        messages: {
          orderBy: {
            sequence: 'asc',
          },
          take: 1, // 只返回第一条消息作为预览
        },
      },
    });
  }

  /**
   * 分页获取会话消息（从 daemon 按需加载）
   */
  async getSessionMessages(
    sessionId: string,
    limit: number = 50,
    offset: number = 0,
    order: 'asc' | 'desc' = 'asc',
  ) {
    // 先查找会话，获取项目路径
    const session = await this.prisma.session.findUnique({
      where: { sessionId },
      select: {
        id: true,
        messageCount: true,
        project: {
          select: {
            path: true,
          },
        },
      },
    });

    if (!session) {
      this.logger.warn(`Session not found: ${sessionId}`);
      return null;
    }

    // 从 daemon 请求消息(daemon 端进行分页)
    this.logger.log(`Requesting messages for session ${sessionId} from daemon (limit: ${limit}, offset: ${offset}, order: ${order})`);
    const result = await this.daemonGateway.requestSessionMessages(
      sessionId,
      session.project.path,
      limit,
      offset,
      order,
    );

    if (!result) {
      this.logger.error(`Failed to get messages for session ${sessionId} from daemon`);
      return null;
    }

    return result;
  }

  /**
   * 删除会话
   */
  async deleteSession(id: number) {
    // Prisma 会自动级联删除相关的 messages
    return this.prisma.session.delete({
      where: { id },
    });
  }
}
