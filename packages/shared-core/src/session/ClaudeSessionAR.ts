import { SessionStatus } from './SessionStatus';
import { ClaudeMessageEntity } from './ClaudeMessageEntity';

/**
 * Claude Session 聚合根
 */
export class ClaudeSessionAR {
  private _messages: ClaudeMessageEntity[] = [];

  constructor(
    private readonly _sessionId: string,
    private readonly _projectId: string,
    private _status: SessionStatus,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  // Getters
  get sessionId(): string {
    return this._sessionId;
  }

  get projectId(): string {
    return this._projectId;
  }

  get status(): SessionStatus {
    return this._status;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get messages(): readonly ClaudeMessageEntity[] {
    return this._messages;
  }

  get messageCount(): number {
    return this._messages.length;
  }

  /**
   * 添加消息
   */
  addMessage(message: ClaudeMessageEntity): void {
    // 检查 uuid 唯一性
    if (this._messages.some((m) => m.uuid === message.uuid)) {
      throw new Error(`Message with uuid ${message.uuid} already exists`);
    }
    this._messages.push(message);
    this.markAsUpdated();
  }

  /**
   * 关闭 session
   */
  close(): void {
    if (this._status !== SessionStatus.ACTIVE) {
      throw new Error('Only active sessions can be closed');
    }
    this._status = SessionStatus.CLOSED;
    this.markAsUpdated();
  }

  /**
   * 归档 session
   */
  archive(): void {
    if (this._status !== SessionStatus.CLOSED) {
      throw new Error('Only closed sessions can be archived');
    }
    this._status = SessionStatus.ARCHIVED;
    this.markAsUpdated();
  }

  /**
   * 标记为已更新
   */
  markAsUpdated(): void {
    this._updatedAt = new Date();
  }

  /**
   * 转换为普通对象
   */
  toPlainObject() {
    return {
      sessionId: this._sessionId,
      projectId: this._projectId,
      status: this._status,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
      messageCount: this._messages.length,
    };
  }

  /**
   * 从普通对象创建
   */
  static fromPlainObject(data: {
    sessionId: string;
    projectId: string;
    status: SessionStatus;
    createdAt: Date;
    updatedAt: Date;
  }): ClaudeSessionAR {
    return new ClaudeSessionAR(
      data.sessionId,
      data.projectId,
      data.status,
      data.createdAt,
      data.updatedAt,
    );
  }
}
