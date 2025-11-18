import { ClaudeSessionAR } from './ClaudeSessionAR';
import { ClaudeMessageEntity } from './ClaudeMessageEntity';

/**
 * Claude Session 基础 Repository 接口
 */
export interface IClaudeSessionBaseRepo {
  /**
   * 保存 session
   */
  save(session: ClaudeSessionAR): Promise<void>;

  /**
   * 通过 sessionId 查找
   */
  findBySessionId(sessionId: string): Promise<ClaudeSessionAR | null>;

  /**
   * 删除 session
   */
  delete(sessionId: string): Promise<void>;

  /**
   * 添加消息
   */
  addMessage(sessionId: string, message: ClaudeMessageEntity): Promise<void>;

  /**
   * 获取消息列表
   */
  getMessages(
    sessionId: string,
    limit?: number,
    offset?: number,
  ): Promise<ClaudeMessageEntity[]>;

  /**
   * 检查消息完整性(返回缺失的消息索引)
   */
  checkMessageIntegrity(sessionId: string): Promise<number[]>;
}
