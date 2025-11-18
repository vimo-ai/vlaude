import { describe, it, expect } from 'vitest';
import { ClaudeMessageEntity } from '../../session/ClaudeMessageEntity';

describe('ClaudeMessageEntity', () => {
  it('should create a valid message', () => {
    const message = new ClaudeMessageEntity(
      'msg-123',
      'user',
      'text',
      { text: 'Hello' },
      new Date().toISOString(),
    );

    expect(message.uuid).toBe('msg-123');
    expect(message.role).toBe('user');
    expect(message.type).toBe('text');
  });

  it('should throw error when uuid is missing', () => {
    expect(
      () =>
        new ClaudeMessageEntity(
          '',
          'user',
          'text',
          {},
          new Date().toISOString(),
        ),
    ).toThrow('Message uuid is required');
  });

  it('should throw error when role is invalid', () => {
    expect(
      () =>
        new ClaudeMessageEntity(
          'msg-123',
          'invalid' as any,
          'text',
          {},
          new Date().toISOString(),
        ),
    ).toThrow('Message role must be user or assistant');
  });

  it('should throw error when timestamp is missing', () => {
    expect(
      () => new ClaudeMessageEntity('msg-123', 'user', 'text', {}, ''),
    ).toThrow('Message timestamp is required');
  });

  it('should throw error when timestamp format is invalid', () => {
    expect(
      () =>
        new ClaudeMessageEntity('msg-123', 'user', 'text', {}, 'invalid-date'),
    ).toThrow('Invalid timestamp format');
  });

  it('should convert to plain object', () => {
    const timestamp = new Date().toISOString();
    const message = new ClaudeMessageEntity(
      'msg-123',
      'user',
      'text',
      { text: 'Hello' },
      timestamp,
    );

    const plain = message.toPlainObject();

    expect(plain).toEqual({
      uuid: 'msg-123',
      role: 'user',
      type: 'text',
      content: { text: 'Hello' },
      timestamp,
    });
  });
});
