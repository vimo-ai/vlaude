/**
 * StatusService - 状态管理业务逻辑层
 * 封装 IStatusManager，提供事件发布能力
 */

import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  IStatusManager,
  StatusDaemonInfo,
  StatusSessionInfo,
  StatusSnapshot,
} from '@vimo-ai/vlaude-shared-core';

export const STATUS_MANAGER_TOKEN = 'IStatusManager';

@Injectable()
export class StatusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatusService.name);

  constructor(
    @Inject(STATUS_MANAGER_TOKEN)
    private readonly statusManager: IStatusManager,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    await this.statusManager.init();
    this.logger.log('StatusService 初始化完成');
  }

  async onModuleDestroy() {
    await this.statusManager.destroy();
    this.logger.log('StatusService 已销毁');
  }

  // =================== Daemon 事件处理 ===================

  async handleDaemonOnline(deviceId: string, info: StatusDaemonInfo): Promise<void> {
    const result = await this.statusManager.setDaemonOnline(deviceId, info);

    this.logger.log(`🟢 Daemon 上线: ${deviceId} (${info.deviceName}) [重连: ${result.isReconnect}]`);

    // 发布事件，通知 AppGateway 推送给 iOS
    this.eventEmitter.emit('status.daemonOnline', {
      deviceId,
      info,
      isReconnect: result.isReconnect,
    });
  }

  async handleDaemonOffline(deviceId: string): Promise<void> {
    // 获取该 Daemon 的 sessions（用于通知 iOS 更新）
    const sessions = await this.statusManager.getSessionsByDevice(deviceId);
    const affectedProjects = [...new Set(sessions.map((s) => s.projectPath))];

    await this.statusManager.setDaemonOffline(deviceId);

    this.logger.log(`🔴 Daemon 下线: ${deviceId} (影响 ${affectedProjects.length} 个项目)`);

    // 发布事件
    this.eventEmitter.emit('status.daemonOffline', {
      deviceId,
      affectedProjects,
    });
  }

  // =================== Session 事件处理 ===================

  /**
   * Bug #3 修复：添加重试逻辑
   * 当 daemon_not_found 时，可能是 daemon:online 和 sessionStart 几乎同时到达
   * 等待 500ms 重试，最多 3 次
   */
  private static readonly SESSION_RETRY_DELAY = 500;
  private static readonly SESSION_MAX_RETRIES = 3;

  async handleSessionStart(deviceId: string, session: StatusSessionInfo): Promise<void> {
    let result = await this.statusManager.addSession(deviceId, session);
    let retryCount = 0;

    // Bug #3 修复：daemon_not_found 时重试
    while (!result.success && result.reason === 'daemon_not_found' && retryCount < StatusService.SESSION_MAX_RETRIES) {
      retryCount++;
      this.logger.warn(`⏳ Session 添加失败 (daemon_not_found)，等待重试 ${retryCount}/${StatusService.SESSION_MAX_RETRIES}: ${session.sessionId}`);

      await this.delay(StatusService.SESSION_RETRY_DELAY);
      result = await this.statusManager.addSession(deviceId, session);
    }

    if (result.success) {
      if (retryCount > 0) {
        this.logger.log(`📝 Session ${result.reason}: ${session.sessionId} (device: ${deviceId}) [重试 ${retryCount} 次后成功]`);
      } else {
        this.logger.log(`📝 Session ${result.reason}: ${session.sessionId} (device: ${deviceId})`);
      }

      // 发布事件
      this.eventEmitter.emit('status.sessionOnline', {
        deviceId,
        session,
      });
    } else {
      this.logger.warn(`⚠️ Session 添加失败: ${session.sessionId} (原因: ${result.reason}, 重试: ${retryCount} 次)`);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async handleSessionEnd(deviceId: string, sessionId: string): Promise<void> {
    const sessionInfo = await this.statusManager.getSessionInfo(sessionId);

    await this.statusManager.removeSession(deviceId, sessionId);

    this.logger.log(`🗑️ Session 移除: ${sessionId}`);

    // 发布事件
    this.eventEmitter.emit('status.sessionOffline', {
      deviceId,
      sessionId,
      projectPath: sessionInfo?.session.projectPath,
    });
  }

  // =================== 心跳 ===================

  async handleHeartbeat(deviceId: string): Promise<void> {
    await this.statusManager.heartbeat(deviceId);
  }

  // =================== 查询方法（供 Gateway 使用）===================

  /**
   * 检查 ETerm 是否在线
   * ETerm 设备 ID 固定为 "eterm"
   */
  async isEtermOnline(): Promise<boolean> {
    return this.statusManager.isDaemonOnline('eterm');
  }

  /**
   * 检查指定 session 是否在 ETerm 中可用
   */
  async isSessionInEterm(sessionId: string): Promise<boolean> {
    // 调试：打印所有已注册的 sessions
    const snapshot = await this.statusManager.getSnapshot();
    const allSessionIds = Object.values(snapshot.sessions).flat().map(s => s.sessionId);
    this.logger.log(`🔍 [调试] 查询 sessionId: "${sessionId}" (长度: ${sessionId.length})`);
    this.logger.log(`🔍 [调试] 已注册的 sessions: ${JSON.stringify(allSessionIds)}`);

    const info = await this.statusManager.getSessionInfo(sessionId);
    this.logger.log(`🔍 [调试] getSessionInfo 结果: ${JSON.stringify(info)}`);
    return info?.deviceId === 'eterm';
  }

  /**
   * 获取 ETerm 中的所有 session
   */
  async getEtermSessions(): Promise<string[]> {
    const sessions = await this.statusManager.getSessionsByDevice('eterm');
    return sessions.map((s) => s.sessionId);
  }

  /**
   * 获取每个项目的在线会话数
   */
  async getSessionCountsByProject(): Promise<Record<string, number>> {
    return this.statusManager.getSessionCountsByProject();
  }

  /**
   * 获取完整状态快照
   */
  async getSnapshot(): Promise<StatusSnapshot> {
    return this.statusManager.getSnapshot();
  }

  /**
   * 获取所有在线 Daemon
   */
  async getOnlineDaemons(): Promise<StatusDaemonInfo[]> {
    return this.statusManager.getOnlineDaemons();
  }

  /**
   * 获取指定 Daemon 信息
   */
  async getDaemonInfo(deviceId: string): Promise<StatusDaemonInfo | null> {
    return this.statusManager.getDaemonInfo(deviceId);
  }

  /**
   * 获取指定 Daemon 的所有 session
   */
  async getSessionsByDevice(deviceId: string): Promise<StatusSessionInfo[]> {
    return this.statusManager.getSessionsByDevice(deviceId);
  }
}
