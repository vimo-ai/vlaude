import { describe, it, expect } from 'vitest';
import { ClaudeSessionAR } from '../../session/ClaudeSessionAR';
import { ClaudeMessageEntity } from '../../session/ClaudeMessageEntity';
import { SessionStatus } from '../../session/SessionStatus';

describe('ClaudeSessionAR', () => {
  it('should create a session with initial status', () => {
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.ACTIVE,
      new Date(),
      new Date(),
    );

    expect(session.sessionId).toBe('session-123');
    expect(session.projectId).toBe('project-456');
    expect(session.status).toBe(SessionStatus.ACTIVE);
    expect(session.messageCount).toBe(0);
  });

  it('should add message successfully', () => {
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.ACTIVE,
      new Date(),
      new Date(),
    );

    const message = new ClaudeMessageEntity(
      'msg-1',
      'user',
      'text',
      { text: 'Hello' },
      new Date().toISOString(),
    );

    session.addMessage(message);

    expect(session.messageCount).toBe(1);
    expect(session.messages[0]).toBe(message);
  });

  it('should throw error when adding duplicate message uuid', () => {
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.ACTIVE,
      new Date(),
      new Date(),
    );

    const message1 = new ClaudeMessageEntity(
      'msg-1',
      'user',
      'text',
      {},
      new Date().toISOString(),
    );
    const message2 = new ClaudeMessageEntity(
      'msg-1', // 重复的 uuid
      'assistant',
      'text',
      {},
      new Date().toISOString(),
    );

    session.addMessage(message1);

    expect(() => session.addMessage(message2)).toThrow(
      'Message with uuid msg-1 already exists',
    );
  });

  it('should close active session', () => {
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.ACTIVE,
      new Date(),
      new Date(),
    );

    session.close();

    expect(session.status).toBe(SessionStatus.CLOSED);
  });

  it('should throw error when closing non-active session', () => {
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.CLOSED,
      new Date(),
      new Date(),
    );

    expect(() => session.close()).toThrow(
      'Only active sessions can be closed',
    );
  });

  it('should archive closed session', () => {
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.CLOSED,
      new Date(),
      new Date(),
    );

    session.archive();

    expect(session.status).toBe(SessionStatus.ARCHIVED);
  });

  it('should throw error when archiving non-closed session', () => {
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.ACTIVE,
      new Date(),
      new Date(),
    );

    expect(() => session.archive()).toThrow(
      'Only closed sessions can be archived',
    );
  });

  it('should update timestamp when marked as updated', () => {
    const initialDate = new Date('2024-01-01');
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.ACTIVE,
      initialDate,
      initialDate,
    );

    const beforeUpdate = session.updatedAt;

    // 等待一点时间确保时间戳不同
    setTimeout(() => {
      session.markAsUpdated();
      expect(session.updatedAt.getTime()).toBeGreaterThan(
        beforeUpdate.getTime(),
      );
    }, 10);
  });

  it('should expose all properties through getters', () => {
    const createdAt = new Date('2024-01-01');
    const updatedAt = new Date('2024-01-02');
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.ACTIVE,
      createdAt,
      updatedAt,
    );

    expect(session.sessionId).toBe('session-123');
    expect(session.projectId).toBe('project-456');
    expect(session.status).toBe(SessionStatus.ACTIVE);
    expect(session.createdAt).toBe(createdAt);
    expect(session.updatedAt).toBe(updatedAt);
    expect(session.messages).toEqual([]);
    expect(session.messageCount).toBe(0);
  });

  it('should return messages array', () => {
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.ACTIVE,
      new Date(),
      new Date(),
    );

    const message1 = new ClaudeMessageEntity(
      'msg-1',
      'user',
      'text',
      {},
      new Date().toISOString(),
    );
    const message2 = new ClaudeMessageEntity(
      'msg-2',
      'assistant',
      'text',
      {},
      new Date().toISOString(),
    );

    session.addMessage(message1);
    session.addMessage(message2);

    const messages = session.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(message1);
    expect(messages[1]).toBe(message2);
  });

  it('should update messageCount when adding messages', () => {
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.ACTIVE,
      new Date(),
      new Date(),
    );

    expect(session.messageCount).toBe(0);

    session.addMessage(
      new ClaudeMessageEntity(
        'msg-1',
        'user',
        'text',
        {},
        new Date().toISOString(),
      ),
    );
    expect(session.messageCount).toBe(1);

    session.addMessage(
      new ClaudeMessageEntity(
        'msg-2',
        'assistant',
        'text',
        {},
        new Date().toISOString(),
      ),
    );
    expect(session.messageCount).toBe(2);
  });

  it('should convert to plain object', () => {
    const createdAt = new Date('2024-01-01');
    const updatedAt = new Date('2024-01-02');
    const session = new ClaudeSessionAR(
      'session-123',
      'project-456',
      SessionStatus.ACTIVE,
      createdAt,
      updatedAt,
    );

    session.addMessage(
      new ClaudeMessageEntity(
        'msg-1',
        'user',
        'text',
        {},
        new Date().toISOString(),
      ),
    );

    const plain = session.toPlainObject();

    expect(plain.sessionId).toBe('session-123');
    expect(plain.projectId).toBe('project-456');
    expect(plain.status).toBe(SessionStatus.ACTIVE);
    expect(plain.createdAt).toBe(createdAt);
    expect(plain.messageCount).toBe(1);
    // updatedAt 会被 addMessage 更新,只验证它存在且是 Date
    expect(plain.updatedAt).toBeInstanceOf(Date);
    expect(plain.updatedAt.getTime()).toBeGreaterThanOrEqual(
      updatedAt.getTime(),
    );
  });

  it('should create from plain object', () => {
    const createdAt = new Date('2024-01-01');
    const updatedAt = new Date('2024-01-02');

    const session = ClaudeSessionAR.fromPlainObject({
      sessionId: 'session-123',
      projectId: 'project-456',
      status: SessionStatus.CLOSED,
      createdAt,
      updatedAt,
    });

    expect(session.sessionId).toBe('session-123');
    expect(session.projectId).toBe('project-456');
    expect(session.status).toBe(SessionStatus.CLOSED);
    expect(session.createdAt).toBe(createdAt);
    expect(session.updatedAt).toBe(updatedAt);
    expect(session.messageCount).toBe(0);
  });
});
