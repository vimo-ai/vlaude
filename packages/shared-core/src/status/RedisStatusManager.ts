/**
 * Redis 模式状态管理器
 * 用于生产环境，支持多实例、状态持久化
 *
 * Key 设计：
 * - vlaude:status:daemon:{deviceId}          -> DaemonInfo JSON (TTL)
 * - vlaude:status:daemon:{deviceId}:sessions -> Set<sessionId> (TTL)
 * - vlaude:status:session:{sessionId}        -> SessionInfo + deviceId JSON (TTL)
 */

import Redis from 'ioredis';
import {
  IStatusManager,
  DaemonInfo,
  SessionInfo,
  StatusSnapshot,
  StatusManagerConfig,
} from './IStatusManager';

export class RedisStatusManager implements IStatusManager {
  private redis: Redis;
  private readonly keyPrefix: string;
  private readonly ttl: number;

  constructor(config: StatusManagerConfig) {
    const {
      host = 'localhost',
      port = 6379,
      password,
      keyPrefix = 'vlaude:status:',
      ttl = 60,
    } = config;

    this.keyPrefix = keyPrefix;
    this.ttl = ttl;

    this.redis = new Redis({
      host,
      port,
      password,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 1000, 5000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    this.redis.on('error', (err: Error) => {
      console.error('[RedisStatusManager] Redis 连接错误:', err.message);
    });

    this.redis.on('connect', () => {
      console.log('[RedisStatusManager] Redis 连接成功');
    });
  }

  async init(): Promise<void> {
    // Redis 连接已在构造函数中建立
    console.log(`[RedisStatusManager] 初始化完成 (TTL: ${this.ttl}s)`);
  }

  async destroy(): Promise<void> {
    await this.redis.quit();
    console.log('[RedisStatusManager] 已断开连接');
  }

  // =================== Daemon 状态 ===================

  async setDaemonOnline(
    deviceId: string,
    info: DaemonInfo,
  ): Promise<{ isReconnect: boolean }> {
    const daemonKey = this.buildDaemonKey(deviceId);

    // 检查是否已存在（重连场景）
    const existing = await this.redis.exists(daemonKey);
    const isReconnect = existing === 1;

    // Bug #2 修复：重连时清除旧 sessions，但新连接不清除
    // 注意：不能无条件 del，否则会和并发的 addSession 产生竞态条件
    if (isReconnect) {
      await this.clearDaemonSessions(deviceId);
    }

    // 设置新状态
    await this.redis.setex(daemonKey, this.ttl, JSON.stringify(info));

    // 注意：不再无条件初始化 sessions set
    // 如果是重连，clearDaemonSessions 已经清理了
    // 如果是新连接，sessions set 会在 addSession 时创建

    return { isReconnect };
  }

  async setDaemonOffline(deviceId: string): Promise<void> {
    const daemonKey = this.buildDaemonKey(deviceId);

    // 幂等：不存在则静默返回
    const exists = await this.redis.exists(daemonKey);
    if (!exists) return;

    await this.clearDaemonSessions(deviceId);
    await this.redis.del(daemonKey);
  }

  async isDaemonOnline(deviceId: string): Promise<boolean> {
    const daemonKey = this.buildDaemonKey(deviceId);
    return (await this.redis.exists(daemonKey)) === 1;
  }

  async getOnlineDaemons(): Promise<DaemonInfo[]> {
    const pattern = `${this.keyPrefix}daemon:*`;
    const daemonKeys = await this.scanKeys(pattern, (k) => !k.endsWith(':sessions'));

    const daemons: DaemonInfo[] = [];
    for (const key of daemonKeys) {
      const value = await this.redis.get(key);
      if (value) {
        try {
          daemons.push(JSON.parse(value));
        } catch {
          console.warn(`[RedisStatusManager] 解析 Daemon 信息失败: ${key}`);
        }
      }
    }

    return daemons;
  }

  async getDaemonInfo(deviceId: string): Promise<DaemonInfo | null> {
    const daemonKey = this.buildDaemonKey(deviceId);
    const value = await this.redis.get(daemonKey);
    if (!value) return null;

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  // =================== Session 状态 ===================

  async addSession(
    deviceId: string,
    session: SessionInfo,
  ): Promise<{
    success: boolean;
    reason?: 'added' | 'updated' | 'daemon_not_found';
  }> {
    const daemonKey = this.buildDaemonKey(deviceId);
    const sessionsKey = this.buildDaemonSessionsKey(deviceId);
    const sessionKey = this.buildSessionKey(session.sessionId);

    // 检查 daemon 是否存在
    const daemonExists = await this.redis.exists(daemonKey);
    if (!daemonExists) {
      return { success: false, reason: 'daemon_not_found' };
    }

    // 检查 session 是否已存在（幂等）
    const sessionExists = await this.redis.exists(sessionKey);
    const reason = sessionExists ? 'updated' : 'added';

    const pipeline = this.redis.pipeline();
    pipeline.sadd(sessionsKey, session.sessionId);
    pipeline.expire(sessionsKey, this.ttl);
    pipeline.setex(
      sessionKey,
      this.ttl,
      JSON.stringify({ ...session, deviceId }),
    );
    const results = await pipeline.exec();

    // 检查 pipeline 错误
    if (results) {
      for (const [err] of results) {
        if (err) {
          console.error('[RedisStatusManager] addSession pipeline 错误:', err);
        }
      }
    }

    return { success: true, reason };
  }

  async removeSession(deviceId: string, sessionId: string): Promise<void> {
    const sessionsKey = this.buildDaemonSessionsKey(deviceId);
    const sessionKey = this.buildSessionKey(sessionId);

    // 幂等：不检查是否存在，直接删除
    const pipeline = this.redis.pipeline();
    pipeline.srem(sessionsKey, sessionId);
    pipeline.del(sessionKey);
    const results = await pipeline.exec();

    // 检查 pipeline 错误
    if (results) {
      for (const [err] of results) {
        if (err) {
          console.error('[RedisStatusManager] removeSession pipeline 错误:', err);
        }
      }
    }
  }

  async getSessionsByDevice(deviceId: string): Promise<SessionInfo[]> {
    const sessionsKey = this.buildDaemonSessionsKey(deviceId);
    const sessionIds = await this.redis.smembers(sessionsKey);

    const sessions: SessionInfo[] = [];
    for (const sid of sessionIds) {
      const sessionKey = this.buildSessionKey(sid);
      const value = await this.redis.get(sessionKey);
      if (value) {
        try {
          const data = JSON.parse(value);
          // 移除 deviceId 字段，只返回 SessionInfo
          const { deviceId: _, ...session } = data;
          sessions.push(session as SessionInfo);
        } catch {
          // 忽略解析错误
        }
      }
    }

    return sessions;
  }

  async getSessionCountsByProject(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    // 使用 SCAN 获取所有 session keys
    const pattern = `${this.keyPrefix}session:*`;
    const keys = await this.scanKeys(pattern);

    for (const key of keys) {
      const value = await this.redis.get(key);
      if (value) {
        try {
          const data = JSON.parse(value);
          const projectPath = data.projectPath;
          if (projectPath) {
            counts[projectPath] = (counts[projectPath] || 0) + 1;
          }
        } catch {
          // 忽略解析错误
        }
      }
    }

    return counts;
  }

  async isSessionOnline(sessionId: string): Promise<boolean> {
    const sessionKey = this.buildSessionKey(sessionId);
    return (await this.redis.exists(sessionKey)) === 1;
  }

  async getSessionInfo(
    sessionId: string,
  ): Promise<{ session: SessionInfo; deviceId: string } | null> {
    const sessionKey = this.buildSessionKey(sessionId);
    const value = await this.redis.get(sessionKey);
    if (!value) return null;

    try {
      const data = JSON.parse(value);
      const { deviceId, ...session } = data;
      return { session: session as SessionInfo, deviceId };
    } catch {
      return null;
    }
  }

  // =================== 快照 ===================

  async getSnapshot(): Promise<StatusSnapshot> {
    const daemons = await this.getOnlineDaemons();
    const sessions: Record<string, SessionInfo[]> = {};
    const sessionCounts: Record<string, number> = {};

    for (const daemon of daemons) {
      const deviceId = daemon.deviceId;
      const deviceSessions = await this.getSessionsByDevice(deviceId);
      sessions[deviceId] = deviceSessions;

      // 统计 projectPath
      for (const session of deviceSessions) {
        sessionCounts[session.projectPath] =
          (sessionCounts[session.projectPath] || 0) + 1;
      }
    }

    return { daemons, sessions, sessionCounts, timestamp: Date.now() };
  }

  // =================== 心跳 ===================

  async heartbeat(deviceId: string): Promise<void> {
    const daemonKey = this.buildDaemonKey(deviceId);
    const sessionsKey = this.buildDaemonSessionsKey(deviceId);

    const pipeline = this.redis.pipeline();

    // 1. 续期 daemon key
    pipeline.expire(daemonKey, this.ttl);

    // 2. 续期 sessions set
    pipeline.expire(sessionsKey, this.ttl);

    const results = await pipeline.exec();

    // 检查 pipeline 错误
    if (results) {
      for (const [err] of results) {
        if (err) {
          console.error('[RedisStatusManager] heartbeat pipeline 错误:', err);
        }
      }
    }

    // 3. 续期所有 session keys（关键！）
    const sessionIds = await this.redis.smembers(sessionsKey);
    if (sessionIds.length > 0) {
      const sessionPipeline = this.redis.pipeline();
      for (const sid of sessionIds) {
        sessionPipeline.expire(this.buildSessionKey(sid), this.ttl);
      }
      const sessionResults = await sessionPipeline.exec();

      if (sessionResults) {
        for (const [err] of sessionResults) {
          if (err) {
            console.error('[RedisStatusManager] heartbeat session pipeline 错误:', err);
          }
        }
      }
    }
  }

  // =================== 私有方法 ===================

  private buildDaemonKey(deviceId: string): string {
    return `${this.keyPrefix}daemon:${deviceId}`;
  }

  private buildDaemonSessionsKey(deviceId: string): string {
    return `${this.keyPrefix}daemon:${deviceId}:sessions`;
  }

  private buildSessionKey(sessionId: string): string {
    return `${this.keyPrefix}session:${sessionId}`;
  }

  private async clearDaemonSessions(deviceId: string): Promise<void> {
    const sessionsKey = this.buildDaemonSessionsKey(deviceId);
    const sessionIds = await this.redis.smembers(sessionsKey);

    // 总是删除 sessions set，即使为空也要清理
    const pipeline = this.redis.pipeline();
    for (const sid of sessionIds) {
      pipeline.del(this.buildSessionKey(sid));
    }
    pipeline.del(sessionsKey);
    const results = await pipeline.exec();

    // 检查 pipeline 错误
    if (results) {
      for (const [err] of results) {
        if (err) {
          console.error('[RedisStatusManager] clearDaemonSessions pipeline 错误:', err);
        }
      }
    }
  }

  /**
   * 使用 SCAN 迭代获取匹配的 keys（避免 KEYS 的 O(N) 阻塞）
   * @param pattern - 匹配模式
   * @param filter - 可选的过滤函数
   */
  private async scanKeys(
    pattern: string,
    filter?: (key: string) => boolean,
  ): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;

      for (const key of batch) {
        if (!filter || filter(key)) {
          keys.push(key);
        }
      }
    } while (cursor !== '0');

    return keys;
  }
}
