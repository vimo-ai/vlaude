/**
 * @description Session Service - 会话数据管理
 * @author Claude
 * @date 2025/12/31
 * @version v3.0.0
 *
 * V3 架构改进:
 * - 唯一数据源: SharedDbService (ai-cli-session.db)
 * - 移除 Prisma 和 Daemon 依赖
 */
import { Injectable, Logger } from '@nestjs/common';
import { SharedDbService, SharedSession, SharedMessage } from '../../shared-db/shared-db.service';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly sharedDb: SharedDbService) {}

  /**
   * 根据项目路径获取会话列表（分页）
   */
  async getSessionsByProjectPath(projectPath: string, limit = 20, offset = 0) {
    if (!this.sharedDb.isAvailable()) {
      return { sessions: [], total: 0, hasMore: false };
    }

    const project = this.sharedDb.getProjectByPath(projectPath);
    if (!project) {
      return { sessions: [], total: 0, hasMore: false };
    }

    const allSessions = this.sharedDb.getSessionsByProjectId(project.id);
    const total = allSessions.length;
    const sessions = allSessions.slice(offset, offset + limit).map(s => this.mapSession(s));
    const hasMore = offset + sessions.length < total;

    return { sessions, total, hasMore };
  }

  /**
   * 根据项目 ID 获取会话列表
   */
  async getSessionsByProject(projectId: number) {
    if (!this.sharedDb.isAvailable()) {
      return [];
    }

    const sessions = this.sharedDb.getSessionsByProjectId(projectId);
    return sessions.map(s => this.mapSession(s));
  }

  /**
   * 根据 session_id 获取会话
   */
  async getSessionBySessionId(sessionId: string) {
    if (!this.sharedDb.isAvailable()) {
      return null;
    }

    const session = this.sharedDb.getSessionBySessionId(sessionId);
    if (!session) {
      return null;
    }

    return this.mapSession(session);
  }

  /**
   * 根据 ID 获取会话
   */
  async getSessionById(id: number) {
    if (!this.sharedDb.isAvailable()) {
      return null;
    }

    // SharedDb 没有直接通过 id 查询的方法，需要遍历
    // 这里简化处理，实际应该加一个方法
    this.logger.warn(`getSessionById(${id}) 暂不支持，请使用 getSessionBySessionId`);
    return null;
  }

  /**
   * 获取会话消息（分页）
   */
  async getSessionMessages(sessionId: string, limit = 50, offset = 0, order: 'asc' | 'desc' = 'asc') {
    if (!this.sharedDb.isAvailable()) {
      return null;
    }

    const session = this.sharedDb.getSessionBySessionId(sessionId);
    if (!session) {
      return null;
    }

    let messages = this.sharedDb.getMessagesBySessionId(sessionId);
    const total = messages.length;

    if (order === 'desc') {
      messages = messages.reverse();
    }

    messages = messages.slice(offset, offset + limit);
    const hasMore = offset + messages.length < total;

    return {
      messages: messages.map(m => this.mapMessage(m)),
      total,
      hasMore,
    };
  }

  /**
   * 创建会话（不支持，只读数据源）
   */
  async createSession(projectPath: string, prompt?: string, requestId?: string) {
    throw new Error('SharedDb 是只读数据源，不支持创建会话');
  }

  /**
   * 删除会话（不支持，只读数据源）
   */
  async deleteSession(id: number) {
    throw new Error('SharedDb 是只读数据源，不支持删除操作');
  }

  /**
   * 转换会话数据格式
   */
  private mapSession(s: SharedSession) {
    return {
      id: s.id,
      sessionId: s.session_id,
      projectId: s.project_id,
      messageCount: s.message_count,
      // lastMessageAt 可能是 null，需要判断后转换为 ISO8601
      lastMessageAt: s.last_message_at ? new Date(s.last_message_at).toISOString() : null,
      createdAt: new Date(s.created_at).toISOString(),
      updatedAt: new Date(s.updated_at).toISOString(),
    };
  }

  /**
   * 转换消息数据格式
   * 格式兼容 iOS Vlaude Message 模型
   */
  private mapMessage(m: SharedMessage) {
    // 将 Unix 毫秒时间戳转换为 ISO8601 格式
    const timestampISO = new Date(m.timestamp).toISOString();

    // 解析 content_full，可能是 JSON 数组或纯文本
    let parsedContent: any;
    try {
      parsedContent = JSON.parse(m.content_full);
    } catch {
      // 不是 JSON，当作纯文本处理
      parsedContent = m.content_full;
    }

    // 基础消息结构
    const result: any = {
      uuid: m.uuid,
      type: m.type,
      timestamp: timestampISO,
      sessionId: m.session_id,
      sequence: m.sequence,
    };

    // 根据消息类型设置内容
    if (m.type === 'user' || m.type === 'assistant') {
      // user/assistant 消息使用 message 对象
      result.message = {
        role: m.type,
        content: parsedContent,
      };
    } else {
      // system 等其他类型直接使用 content
      result.content = typeof parsedContent === 'string' ? parsedContent : m.content_text;
    }

    return result;
  }
}
