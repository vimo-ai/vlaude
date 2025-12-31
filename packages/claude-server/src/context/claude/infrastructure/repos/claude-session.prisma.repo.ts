/**
 * @description Claude Session Prisma 仓储实现
 * @author Claude Code
 * @date 2025-11-12
 * @version v1.0.0
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/database/service/prisma.service';
import { ClaudeSessionDomainRepo } from '../../domain/repos/claude-session.domain.repo';
import { ClaudeSessionAR, SessionStatus } from '../../domain/ar/claude-session.ar';
import { ClaudeMessageEntity } from '../../domain/entities/claude-message.entity';

@Injectable()
export class ClaudeSessionPrismaRepo implements ClaudeSessionDomainRepo {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: number, includeMessages = false): Promise<ClaudeSessionAR | null> {
    const doEntity = await this.prisma.claudeSession.findFirst({
      where: { id, delete: false },
      include: {
        messages: includeMessages ? { where: { delete: false }, orderBy: { sequence: 'asc' } } : false,
      },
    });

    if (!doEntity) {
      return null;
    }

    return ClaudeSessionAR.fromDO(doEntity);
  }

  async findByClaudeSessionId(
    claudeSessionId: string,
    includeMessages = false,
  ): Promise<ClaudeSessionAR | null> {
    const doEntity = await this.prisma.claudeSession.findFirst({
      where: { claudeSessionId, delete: false },
      include: {
        messages: includeMessages ? { where: { delete: false }, orderBy: { sequence: 'asc' } } : false,
      },
    });

    if (!doEntity) {
      return null;
    }

    return ClaudeSessionAR.fromDO(doEntity);
  }

  async findByNamespaceId(namespaceId: number): Promise<ClaudeSessionAR[]> {
    const doEntities = await this.prisma.claudeSession.findMany({
      where: { namespaceId, delete: false },
      orderBy: { createdAt: 'desc' },
    });

    return doEntities.map((doEntity) => ClaudeSessionAR.fromDO(doEntity));
  }

  /**
   * 根据 Action Issue ID 查找会话
   */
  async findByActionIssueId(actionIssueId: number): Promise<ClaudeSessionAR[]> {
    const doEntities = await this.prisma.claudeSession.findMany({
      where: {
        actionIssueId,
        sessionType: 'action',
        delete: false,
      },
      orderBy: { createdAt: 'desc' },
    });

    return doEntities.map((doEntity) => ClaudeSessionAR.fromDO(doEntity));
  }

  async save(session: ClaudeSessionAR): Promise<ClaudeSessionAR> {
    const doEntity = await this.prisma.claudeSession.create({
      data: session.toDO() as any,
    });

    return ClaudeSessionAR.fromDO(doEntity);
  }

  async update(id: number, data: Partial<ClaudeSessionAR>): Promise<ClaudeSessionAR> {
    const doEntity = await this.prisma.claudeSession.update({
      where: { id },
      data: data as any,
    });

    return ClaudeSessionAR.fromDO(doEntity);
  }

  async remove(id: number): Promise<void> {
    await this.prisma.claudeSession.update({
      where: { id },
      data: { delete: true },
    });
  }

  async saveMessage(message: ClaudeMessageEntity): Promise<ClaudeMessageEntity> {
    const data = message.toDO();
    console.log(`💾 [saveMessage] 准备保存消息到数据库:`, {
      sessionId: data.sessionId,
      messageId: data.messageId,
      role: data.role,
      messageType: data.messageType,
    });

    // 获取当前会话的最大序列号
    const maxSequence = await this.prisma.claudeMessage.aggregate({
      where: { sessionId: data.sessionId },
      _max: { sequence: true },
    });

    const nextSequence = (maxSequence._max.sequence || 0) + 1;

    // 使用 upsert 实现幂等性保存
    const doEntity = await this.prisma.claudeMessage.upsert({
      where: {
        messageId: data.messageId,
      },
      update: {
        // 如果消息已存在，更新内容（适用于 streaming 场景）
        content: data.content,
        metadata: data.metadata,
        tokenUsage: data.tokenUsage,
        costUsd: data.costUsd,
      },
      create: {
        // 如果消息不存在，创建新记录
        sessionId: data.sessionId,
        messageId: data.messageId,
        sequence: nextSequence,
        role: data.role,
        messageType: data.messageType,
        content: data.content,
        metadata: data.metadata,
        tokenUsage: data.tokenUsage,
        costUsd: data.costUsd,
        delete: data.delete,
      },
    });

    console.log(`✅ [saveMessage] 消息已保存, id=${doEntity.id}, sequence=${doEntity.sequence}`);

    return ClaudeMessageEntity.fromDO(doEntity);
  }

  async getMessages(sessionId: number): Promise<ClaudeMessageEntity[]> {
    console.log(`[ClaudeSessionPrismaRepo.getMessages] 查询 session ${sessionId} 的消息`);
    const doEntities = await this.prisma.claudeMessage.findMany({
      where: { sessionId, delete: false },
      orderBy: { sequence: 'asc' }, // 按序列号排序，保证顺序正确
    });
    console.log(`[ClaudeSessionPrismaRepo.getMessages] 查询到 ${doEntities.length} 条消息`);
    if (doEntities.length > 0) {
      console.log(`[ClaudeSessionPrismaRepo.getMessages] 第一条消息:`, {
        id: doEntities[0].id,
        messageId: doEntities[0].messageId,
        sequence: doEntities[0].sequence,
        role: doEntities[0].role,
        messageType: doEntities[0].messageType,
      });
    }

    return doEntities.map((doEntity) => ClaudeMessageEntity.fromDO(doEntity));
  }

  async findMessageByMessageId(messageId: string): Promise<ClaudeMessageEntity | null> {
    const doEntity = await this.prisma.claudeMessage.findUnique({
      where: { messageId },
    });

    if (!doEntity) {
      return null;
    }

    return ClaudeMessageEntity.fromDO(doEntity);
  }

  async getMessagesSince(sessionId: number, sinceSequence: number): Promise<ClaudeMessageEntity[]> {
    const doEntities = await this.prisma.claudeMessage.findMany({
      where: {
        sessionId,
        sequence: { gt: sinceSequence },
        delete: false,
      },
      orderBy: { sequence: 'asc' },
    });

    return doEntities.map((doEntity) => ClaudeMessageEntity.fromDO(doEntity));
  }

  async checkMessageIntegrity(sessionId: number): Promise<number[]> {
    const messages = await this.prisma.claudeMessage.findMany({
      where: { sessionId, delete: false },
      select: { sequence: true },
      orderBy: { sequence: 'asc' },
    });

    if (messages.length === 0) {
      return [];
    }

    const sequences = messages.map((m) => m.sequence);
    const missingSequences: number[] = [];

    // 检查序列号是否连续
    for (let i = 0; i < sequences.length - 1; i++) {
      const current = sequences[i];
      const next = sequences[i + 1];

      // 如果下一个序列号不等于当前序列号+1，说明有缺失
      if (next !== current + 1) {
        // 记录所有缺失的序列号
        for (let missing = current + 1; missing < next; missing++) {
          missingSequences.push(missing);
        }
      }
    }

    return missingSequences;
  }

  /**
   * 批量更新所有 active 状态的会话为指定状态
   */
  async closeAllActiveSessions(newStatus: SessionStatus): Promise<number> {
    const result = await this.prisma.claudeSession.updateMany({
      where: {
        status: SessionStatus.ACTIVE,
        delete: false,
      },
      data: {
        status: newStatus,
      },
    });

    return result.count;
  }
}
