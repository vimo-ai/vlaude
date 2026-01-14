/**
 * @description DataSync Service - 数据同步服务
 * @author Claude
 * @date 2025/01/14
 * @version v1.0.0
 *
 * Phase 3: 支持两种部署模式
 * - forward: 纯转发模式，所有请求穿透到 Daemon，不存储数据
 * - sync: 线上同步模式，Server 缓存数据，iOS 可快速访问
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../shared/database/prisma.service';

// 同步模式枚举
export type SyncMode = 'forward' | 'sync';

// 消息数据类型（来自 Daemon）
export interface DaemonMessage {
  uuid: string;
  role: string;
  content: string;
  metadata?: any;
  sequence: number;
  timestamp: string | Date;
  toolCallId?: string;
  approvalStatus?: string;
  approvalResolvedAt?: number;
}

// 审批状态枚举
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

@Injectable()
export class DataSyncService implements OnModuleInit {
  private readonly logger = new Logger(DataSyncService.name);
  private readonly syncMode: SyncMode;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    // 从环境变量读取同步模式，默认为 forward
    const mode = this.configService.get<string>('DATA_SYNC_MODE', 'forward');
    this.syncMode = mode === 'sync' ? 'sync' : 'forward';
  }

  async onModuleInit() {
    this.logger.log(`📊 [DataSync] 同步模式: ${this.syncMode}`);
    if (this.syncMode === 'forward') {
      this.logger.log('   纯转发模式：所有请求穿透到 Daemon，不存储数据');
    } else {
      this.logger.log('   线上同步模式：Server 缓存数据，iOS 可快速访问');
    }
  }

  /**
   * 获取当前同步模式
   */
  getSyncMode(): SyncMode {
    return this.syncMode;
  }

  /**
   * 是否为线上同步模式
   */
  isSyncMode(): boolean {
    return this.syncMode === 'sync';
  }

  /**
   * 是否为纯转发模式
   */
  isForwardMode(): boolean {
    return this.syncMode === 'forward';
  }

  // =================== 数据写入方法（仅 sync 模式使用）===================

  /**
   * 确保 Project 存在（upsert）
   */
  async ensureProject(projectPath: string, name?: string): Promise<number> {
    if (!this.isSyncMode()) {
      throw new Error('ensureProject only available in sync mode');
    }

    const project = await this.prisma.project.upsert({
      where: { path: projectPath },
      update: {
        lastAccessed: new Date(),
      },
      create: {
        path: projectPath,
        name: name || projectPath.split('/').pop() || 'Unknown',
        lastAccessed: new Date(),
      },
    });

    return project.id;
  }

  /**
   * 确保 Session 存在（upsert）
   */
  async ensureSession(sessionId: string, projectId: number, projectPath: string): Promise<number> {
    if (!this.isSyncMode()) {
      throw new Error('ensureSession only available in sync mode');
    }

    const session = await this.prisma.session.upsert({
      where: { sessionId },
      update: {
        // 只更新必要字段
      },
      create: {
        sessionId,
        projectId,
        projectPath,
      },
    });

    return session.id;
  }

  /**
   * 批量写入消息（增量同步）
   * 基于 uuid 去重，只插入新消息
   *
   * 注：Claude JSONL 的 UUID 是全局唯一的（message.uuid），不会跨 session 冲突
   */
  async syncMessages(
    sessionDbId: number,
    messages: DaemonMessage[],
  ): Promise<{ inserted: number; updated: number; skipped: number }> {
    if (!this.isSyncMode()) {
      return { inserted: 0, updated: 0, skipped: messages.length };
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const msg of messages) {
      // 跳过没有 uuid 的消息
      if (!msg.uuid) {
        this.logger.warn(`⚠️ [DataSync] 跳过无 uuid 的消息: sequence=${msg.sequence}`);
        skipped++;
        continue;
      }

      try {
        // 先检查消息是否已存在
        const existing = await this.prisma.message.findUnique({
          where: { uuid: msg.uuid },
          select: { id: true },
        });

        if (existing) {
          // 消息已存在，只更新可变字段
          await this.prisma.message.update({
            where: { uuid: msg.uuid },
            data: {
              approvalStatus: msg.approvalStatus,
              approvalResolvedAt: msg.approvalResolvedAt ? BigInt(msg.approvalResolvedAt) : null,
            },
          });
          updated++;
        } else {
          // 新消息，插入
          await this.prisma.message.create({
            data: {
              sessionId: sessionDbId,
              uuid: msg.uuid,
              role: msg.role,
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
              metadata: msg.metadata,
              sequence: msg.sequence,
              timestamp: new Date(msg.timestamp),
              toolCallId: msg.toolCallId,
              approvalStatus: msg.approvalStatus,
              approvalResolvedAt: msg.approvalResolvedAt ? BigInt(msg.approvalResolvedAt) : null,
            },
          });
          inserted++;
        }
      } catch (error: any) {
        // P2002 = 并发插入导致的唯一约束冲突，视为已同步
        if (error.code === 'P2002') {
          this.logger.debug(`ℹ️ [DataSync] 并发写入，消息已存在: ${msg.uuid}`);
          updated++;
        } else {
          this.logger.error(`❌ [DataSync] 写入消息失败: ${error.message}`);
          throw error;
        }
      }
    }

    this.logger.log(`📝 [DataSync] 同步消息: inserted=${inserted}, updated=${updated}, skipped=${skipped}`);
    return { inserted, updated, skipped };
  }

  /**
   * 写入单条新消息（实时推送）
   * 使用 upsert 处理重复，P2002 冲突视为正常情况
   */
  async writeMessage(
    sessionDbId: number,
    message: DaemonMessage,
  ): Promise<boolean> {
    if (!this.isSyncMode()) {
      return false;
    }

    try {
      await this.prisma.message.upsert({
        where: { uuid: message.uuid },
        update: {
          // 只更新可变字段
          approvalStatus: message.approvalStatus,
          approvalResolvedAt: message.approvalResolvedAt ? BigInt(message.approvalResolvedAt) : null,
        },
        create: {
          sessionId: sessionDbId,
          uuid: message.uuid,
          role: message.role,
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          metadata: message.metadata,
          sequence: message.sequence,
          timestamp: new Date(message.timestamp),
          toolCallId: message.toolCallId,
          approvalStatus: message.approvalStatus,
          approvalResolvedAt: message.approvalResolvedAt ? BigInt(message.approvalResolvedAt) : null,
        },
      });
      return true;
    } catch (error: any) {
      // P2002 = unique constraint violation，视为"已同步"
      if (error.code === 'P2002') {
        this.logger.debug(`ℹ️ [DataSync] 消息已存在: ${message.uuid}`);
        return true;  // 返回 true 表示消息已存在，不是错误
      }
      this.logger.error(`❌ [DataSync] 写入消息失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 通过 toolCallId 更新审批状态
   */
  async updateApprovalStatusByToolCallId(
    toolCallId: string,
    status: ApprovalStatus,
    resolvedAt: number,
  ): Promise<number> {
    if (!this.isSyncMode()) {
      return 0;
    }

    const result = await this.prisma.message.updateMany({
      where: { toolCallId },
      data: {
        approvalStatus: status,
        approvalResolvedAt: BigInt(resolvedAt),
      },
    });

    this.logger.log(`🔐 [DataSync] 更新审批状态: toolCallId=${toolCallId}, status=${status}, count=${result.count}`);
    return result.count;
  }

  // =================== 数据读取方法（仅 sync 模式使用）===================

  /**
   * 从 Server DB 获取消息（用于快速响应）
   */
  async getMessagesFromDb(
    sessionId: string,
    limit: number = 50,
    offset: number = 0,
    order: 'asc' | 'desc' = 'asc',
  ): Promise<{
    messages: any[];
    total: number;
    hasMore: boolean;
  } | null> {
    if (!this.isSyncMode()) {
      return null;
    }

    try {
      // 先查找 session
      const session = await this.prisma.session.findUnique({
        where: { sessionId },
      });

      if (!session) {
        return null;
      }

      // 查询消息
      const [messages, total] = await Promise.all([
        this.prisma.message.findMany({
          where: { sessionId: session.id },
          orderBy: { sequence: order },
          skip: offset,
          take: limit,
        }),
        this.prisma.message.count({
          where: { sessionId: session.id },
        }),
      ]);

      // 转换 BigInt 为 number
      const formattedMessages = messages.map((msg) => ({
        ...msg,
        approvalResolvedAt: msg.approvalResolvedAt ? Number(msg.approvalResolvedAt) : null,
      }));

      return {
        messages: formattedMessages,
        total,
        hasMore: offset + messages.length < total,
      };
    } catch (error) {
      this.logger.error(`❌ [DataSync] 读取消息失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 获取待审批的消息
   */
  async getPendingApprovals(sessionId: string): Promise<any[]> {
    if (!this.isSyncMode()) {
      return [];
    }

    const session = await this.prisma.session.findUnique({
      where: { sessionId },
    });

    if (!session) {
      return [];
    }

    const messages = await this.prisma.message.findMany({
      where: {
        sessionId: session.id,
        approvalStatus: 'pending',
      },
      orderBy: { sequence: 'desc' },
    });

    return messages.map((msg) => ({
      ...msg,
      approvalResolvedAt: msg.approvalResolvedAt ? Number(msg.approvalResolvedAt) : null,
    }));
  }

  /**
   * 获取 Session 的 DB ID（用于写入消息）
   */
  async getSessionDbId(sessionId: string): Promise<number | null> {
    const session = await this.prisma.session.findUnique({
      where: { sessionId },
      select: { id: true },
    });
    return session?.id ?? null;
  }
}
