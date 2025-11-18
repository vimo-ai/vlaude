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

      // V2: 从 Daemon 获取文件系统的会话元数据
      const daemonSessions = await this.fetchSessionsFromDaemon(projectPath, limit, offset);

      if (daemonSessions.length === 0) {
        this.logger.warn('Daemon 未返回任何会话');
        const project = await this.prisma.project.findUnique({
          where: { path: projectPath },
        });
        const total = project ? await this.prisma.session.count({
          where: { projectId: project.id, isDeleted: false },
        }) : 0;
        return { sessions: [], total, hasMore: false };
      }

      this.logger.log(`📦 Daemon 返回 ${daemonSessions.length} 个会话`);

      // 2. 增量更新策略：对比 mtime 和 lineCount，识别新/旧会话
      const { newSessions, unchangedSessions } = await this.categorizeSessions(daemonSessions);

      this.logger.log(`🆕 新会话: ${newSessions.length} 个, 📦 未变化: ${unchangedSessions.length} 个`);

      // 3. 更新数据库缓存（只更新有变化的会话）
      if (newSessions.length > 0) {
        await this.updateSessionCache(newSessions, projectPath);
      }

      // 4. 从数据库查询完整数据（包括缓存的 lastMessage）
      const sessionIds = daemonSessions.map(s => s.sessionId);
      const sessions = await this.prisma.session.findMany({
        where: {
          sessionId: { in: sessionIds },
          isDeleted: false,
        },
        orderBy: {
          lastMtime: 'desc',
        },
        include: {
          messages: {
            where: { sequence: 0 }, // sequence = 0 是缓存的 lastMessage
            take: 1,
          },
        },
      });

      // 5. 混合使用缓存和实时数据
      const newSessionIds = new Set(newSessions.map(s => s.sessionId));
      const sessionsWithLastMessage = sessions.map(session => {
        const isNewSession = newSessionIds.has(session.sessionId);

        if (isNewSession) {
          // 新会话或有变化的会话：使用 Daemon 返回的 lastMessage
          const daemonSession = daemonSessions.find(ds => ds.sessionId === session.sessionId);
          this.logger.debug(`[新会话] ${session.sessionId}: lastMessage=${daemonSession?.lastMessage ? 'exists' : 'null'}`);
          return {
            ...session,
            messages: undefined, // 移除 messages 字段
            lastMessage: daemonSession?.lastMessage || null,
          };
        } else {
          // 未变化的会话：使用数据库缓存的 lastMessage
          const cachedMessage = session.messages?.[0];
          this.logger.debug(`[缓存会话] ${session.sessionId}: cachedMessage=${cachedMessage ? 'exists' : 'null'}, metadata=${cachedMessage?.metadata ? 'exists' : 'null'}`);
          return {
            ...session,
            messages: undefined, // 移除 messages 字段
            lastMessage: cachedMessage?.metadata || null, // metadata 中存储了完整的 lastMessage
          };
        }
      });

      // 6. 获取总数并判断是否还有更多
      const project = await this.prisma.project.findUnique({
        where: { path: projectPath },
      });
      const total = project ? await this.prisma.session.count({
        where: { projectId: project.id, isDeleted: false },
      }) : 0;
      const hasMore = offset + sessionsWithLastMessage.length < total;

      this.logger.log(`✅ 返回 ${sessionsWithLastMessage.length} 个会话 (offset=${offset}, total=${total}, hasMore=${hasMore}, ${newSessions.length} 个使用实时数据, ${unchangedSessions.length} 个使用缓存)`);
      return { sessions: sessionsWithLastMessage, total, hasMore };

    } catch (error) {
      this.logger.error(`获取会话列表失败: ${error.message}`);
      // 降级方案：如果 Daemon 不可用，从数据库读取
      const project = await this.prisma.project.findUnique({
        where: { path: projectPath },
      });

      if (!project) {
        return [];
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
   * 从 Daemon 获取会话元数据
   * V2: 只传递 projectPath，Daemon 内部查表
   */
  private async fetchSessionsFromDaemon(projectPath: string, limit: number, offset: number = 0): Promise<DaemonSessionMetadata[]> {
    try {
      const url = `${this.daemonBaseUrl}/sessions?projectPath=${encodeURIComponent(projectPath)}&limit=${limit}&offset=${offset}`;

      this.logger.debug(`🔗 调用 Daemon API: ${url}`);

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
   * 分类会话：识别新会话和未变化会话 (3新7旧策略)
   */
  private async categorizeSessions(daemonSessions: DaemonSessionMetadata[]) {
    const newSessions: DaemonSessionMetadata[] = [];
    const unchangedSessions: DaemonSessionMetadata[] = [];

    for (const daemonSession of daemonSessions) {
      // 从数据库查询该会话
      const dbSession = await this.prisma.session.findUnique({
        where: { sessionId: daemonSession.sessionId },
      });

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

    for (const session of sessions) {
      try {
        // 1. 更新或创建会话记录
        const dbSession = await this.prisma.session.upsert({
          where: { sessionId: session.sessionId },
          update: {
            projectPath,  // V2: 更新 projectPath
            messageCount: session.lineCount,  // V2: 更新消息数量(使用行数)
            lastMtime: new Date(session.lastMtime),
            lastParsedLine: session.lineCount,  // V2: 更新已解析行数(使用总行数)
            updatedAt: new Date(),
          },
          create: {
            sessionId: session.sessionId,
            projectId: project.id,
            projectPath,  // V2: 保存 projectPath
            messageCount: session.lineCount,  // V2: 初始消息数量(使用行数)
            lastMtime: new Date(session.lastMtime),
            createdAt: new Date(session.createdAt),
            lastParsedLine: session.lineCount,  // V2: 初始已解析行数(使用总行数)
            lastFileSize: BigInt(0),
          },
        });

        // 2. 存储最后一条消息到缓存（只在会话有变化时更新）
        try {
          const lastMessage = session.lastMessage;
          this.logger.debug(`检查 lastMessage: session=${session.sessionId}, exists=${!!lastMessage}`);

          if (lastMessage) {
            // 直接存储完整的 metadata，不做复杂的 content 提取
            // role 用于简单标识消息类型
            const role = lastMessage.message?.role || lastMessage.type || 'unknown';
            const timestamp = new Date(lastMessage.timestamp || Date.now());

            this.logger.debug(`准备存储 lastMessage: sessionId=${dbSession.id}, role=${role}`);

            await this.prisma.message.upsert({
              where: {
                sessionId_sequence: {
                  sessionId: dbSession.id,
                  sequence: 0, // sequence = 0 表示"最后一条消息缓存"
                },
              },
              update: {
                role,
                content: '', // content 字段留空，前端从 metadata 解析
                timestamp,
                metadata: lastMessage, // 完整的 JSON 数据
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

            this.logger.debug(`✅ lastMessage 已存储: sessionId=${dbSession.id}, role=${role}`);
          }
        } catch (messageError) {
          this.logger.error(`❌ 缓存最后一条消息失败 ${session.sessionId}: ${messageError.message}`, messageError.stack);
        }

        this.logger.debug(`✅ 会话缓存已更新: ${session.sessionId}`);
      } catch (error) {
        this.logger.error(`更新会话缓存失败 ${session.sessionId}: ${error.message}`);
      }
    }
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
