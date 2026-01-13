/**
 * Memory 模式状态管理器
 * 用于开发环境或无 Redis 场景
 *
 * 限制：
 * - 仅支持单实例部署
 * - Server 重启会丢失状态
 */

import {
  IStatusManager,
  DaemonInfo,
  SessionInfo,
  StatusSnapshot,
  StatusManagerConfig,
} from './IStatusManager';

export class MemoryStatusManager implements IStatusManager {
  // 内存存储
  private daemons = new Map<string, DaemonInfo>();
  private sessions = new Map<string, { session: SessionInfo; deviceId: string }>();
  private daemonSessions = new Map<string, Set<string>>(); // deviceId -> Set<sessionId>

  constructor(_config?: StatusManagerConfig) {
    // Memory 模式不需要配置
  }

  async init(): Promise<void> {
    console.warn('========================================');
    console.warn('  StatusManager 运行在 Memory 模式');
    console.warn('  限制：');
    console.warn('  - 仅支持单实例部署');
    console.warn('  - Server 重启会丢失状态');
    console.warn('  - 生产环境请配置 REDIS_HOST');
    console.warn('========================================');
  }

  async destroy(): Promise<void> {
    this.daemons.clear();
    this.sessions.clear();
    this.daemonSessions.clear();
  }

  // =================== Daemon 状态 ===================

  async setDaemonOnline(
    deviceId: string,
    info: DaemonInfo,
  ): Promise<{ isReconnect: boolean }> {
    const isReconnect = this.daemons.has(deviceId);

    // 如果是重连，先清除旧的 sessions（全量覆盖策略）
    if (isReconnect) {
      await this.clearDaemonSessions(deviceId);
    }

    this.daemons.set(deviceId, info);
    this.daemonSessions.set(deviceId, new Set());

    return { isReconnect };
  }

  async setDaemonOffline(deviceId: string): Promise<void> {
    // 幂等：不存在则静默返回
    if (!this.daemons.has(deviceId)) {
      return;
    }

    await this.clearDaemonSessions(deviceId);
    this.daemons.delete(deviceId);
  }

  async isDaemonOnline(deviceId: string): Promise<boolean> {
    return this.daemons.has(deviceId);
  }

  async getOnlineDaemons(): Promise<DaemonInfo[]> {
    return Array.from(this.daemons.values());
  }

  async getDaemonInfo(deviceId: string): Promise<DaemonInfo | null> {
    return this.daemons.get(deviceId) || null;
  }

  // =================== Session 状态 ===================

  async addSession(
    deviceId: string,
    session: SessionInfo,
  ): Promise<{
    success: boolean;
    reason?: 'added' | 'updated' | 'daemon_not_found';
  }> {
    // 检查 daemon 是否存在
    if (!this.daemons.has(deviceId)) {
      return { success: false, reason: 'daemon_not_found' };
    }

    // 幂等：检查是否已存在
    const existing = this.sessions.has(session.sessionId);
    const reason = existing ? 'updated' : 'added';

    this.sessions.set(session.sessionId, { session, deviceId });
    this.daemonSessions.get(deviceId)!.add(session.sessionId);

    return { success: true, reason };
  }

  async removeSession(deviceId: string, sessionId: string): Promise<void> {
    // 幂等：不存在则静默返回
    if (!this.sessions.has(sessionId)) {
      return;
    }

    this.sessions.delete(sessionId);
    this.daemonSessions.get(deviceId)?.delete(sessionId);
  }

  async getSessionsByDevice(deviceId: string): Promise<SessionInfo[]> {
    const sessionIds = this.daemonSessions.get(deviceId);
    if (!sessionIds) {
      return [];
    }

    const sessions: SessionInfo[] = [];
    for (const sid of sessionIds) {
      const data = this.sessions.get(sid);
      if (data) {
        sessions.push(data.session);
      }
    }
    return sessions;
  }

  async getSessionCountsByProject(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const [, data] of this.sessions) {
      const projectPath = data.session.projectPath;
      counts[projectPath] = (counts[projectPath] || 0) + 1;
    }

    return counts;
  }

  async isSessionOnline(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  async getSessionInfo(
    sessionId: string,
  ): Promise<{ session: SessionInfo; deviceId: string } | null> {
    return this.sessions.get(sessionId) || null;
  }

  // =================== 快照 ===================

  async getSnapshot(): Promise<StatusSnapshot> {
    const daemons = Array.from(this.daemons.values());
    const sessions: Record<string, SessionInfo[]> = {};
    const sessionCounts: Record<string, number> = {};

    for (const [deviceId, sessionIds] of this.daemonSessions) {
      const deviceSessions: SessionInfo[] = [];
      for (const sid of sessionIds) {
        const data = this.sessions.get(sid);
        if (data) {
          deviceSessions.push(data.session);
          sessionCounts[data.session.projectPath] =
            (sessionCounts[data.session.projectPath] || 0) + 1;
        }
      }
      sessions[deviceId] = deviceSessions;
    }

    return { daemons, sessions, sessionCounts, timestamp: Date.now() };
  }

  // =================== 心跳 ===================

  async heartbeat(_deviceId: string): Promise<void> {
    // Memory 模式不需要心跳续期
  }

  // =================== 私有方法 ===================

  private async clearDaemonSessions(deviceId: string): Promise<void> {
    const sessionIds = this.daemonSessions.get(deviceId);
    if (sessionIds) {
      for (const sid of sessionIds) {
        this.sessions.delete(sid);
      }
      this.daemonSessions.delete(deviceId);
    }
  }
}
