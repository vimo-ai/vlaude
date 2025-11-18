/**
 * Claude 消息实体
 */
export class ClaudeMessageEntity {
  constructor(
    public readonly uuid: string,
    public readonly role: 'user' | 'assistant',
    public readonly type: string,
    public readonly content: any,
    public readonly timestamp: string,
  ) {
    this.validate();
  }

  private validate(): void {
    if (!this.uuid) {
      throw new Error('Message uuid is required');
    }
    if (!['user', 'assistant'].includes(this.role)) {
      throw new Error('Message role must be user or assistant');
    }
    if (!this.timestamp) {
      throw new Error('Message timestamp is required');
    }
    // 验证 timestamp 格式
    if (isNaN(Date.parse(this.timestamp))) {
      throw new Error('Invalid timestamp format');
    }
  }

  toPlainObject() {
    return {
      uuid: this.uuid,
      role: this.role,
      type: this.type,
      content: this.content,
      timestamp: this.timestamp,
    };
  }
}
