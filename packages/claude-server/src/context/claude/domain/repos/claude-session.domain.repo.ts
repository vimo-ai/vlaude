/**
 * @description Claude Session 领域仓储接口
 * @author Claude Code
 * @date 2025-11-12
 * @version v1.0.0
 */

import { ClaudeSessionAR, SessionStatus } from '../ar/claude-session.ar';
import { ClaudeMessageEntity } from '../entities/claude-message.entity';

export const CLAUDE_SESSION_DOMAIN_REPO = Symbol('CLAUDE_SESSION_DOMAIN_REPO');

export interface ClaudeSessionDomainRepo {
  /**
   * 根据ID查找会话
   */
  findById(id: number, includeMessages?: boolean): Promise<ClaudeSessionAR | null>;

  /**
   * 根据Claude Session ID查找会话
   */
  findByClaudeSessionId(claudeSessionId: string, includeMessages?: boolean): Promise<ClaudeSessionAR | null>;

  /**
   * 根据Namespace ID查找会话列表
   */
  findByNamespaceId(namespaceId: number): Promise<ClaudeSessionAR[]>;

  /**
   * 根据 Action Issue ID 查找会话列表
   */
  findByActionIssueId(actionIssueId: number): Promise<ClaudeSessionAR[]>;

  /**
   * 保存会话
   */
  save(session: ClaudeSessionAR): Promise<ClaudeSessionAR>;

  /**
   * 更新会话
   */
  update(id: number, data: Partial<ClaudeSessionAR>): Promise<ClaudeSessionAR>;

  /**
   * 删除会话 (软删除)
   */
  remove(id: number): Promise<void>;

  /**
   * 保存消息
   */
  saveMessage(message: ClaudeMessageEntity): Promise<ClaudeMessageEntity>;

  /**
   * 获取会话的所有消息
   */
  getMessages(sessionId: number): Promise<ClaudeMessageEntity[]>;

  /**
   * 根据 messageId 查找消息
   */
  findMessageByMessageId(messageId: string): Promise<ClaudeMessageEntity | null>;

  /**
   * 获取会话中序列号大于指定值的消息（增量同步）
   */
  getMessagesSince(sessionId: number, sinceSequence: number): Promise<ClaudeMessageEntity[]>;

  /**
   * 检查会话消息完整性（返回缺失的序列号）
   */
  checkMessageIntegrity(sessionId: number): Promise<number[]>;

  /**
   * 批量更新所有 active 状态的会话为指定状态
   * 用于服务启动时清理未正常结束的会话
   */
  closeAllActiveSessions(newStatus: SessionStatus): Promise<number>;
}
