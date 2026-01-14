/**
 * @description Session Service - 会话数据管理
 * @author Claude
 * @date 2025/01/09
 * @version v5.0.0
 *
 * V4 架构改进:
 * - 纯代理模式: 所有请求透传到 Daemon
 * - 移除 SharedDbService (SQLite) 依赖
 * - Server 可部署到云端/NAS
 * - 返回 status 字段区分离线和空数据
 *
 * V5 (Phase 3) 架构改进:
 * - 支持两种部署模式: forward (纯转发) / sync (线上同步)
 * - sync 模式下: 并行读 Server DB + 请求 Daemon
 * - 支持 approval_status 字段
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { DaemonGateway } from '../daemon-gateway/daemon.gateway';
import { DataSyncService, DaemonMessage } from '../data-sync';

// API 响应类型
interface ApiResponse<T> {
  status: 'ok' | 'offline' | 'error';
  data?: T;
  message?: string;
  source?: 'db' | 'daemon' | 'merged';  // V5: 数据来源标记
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(forwardRef(() => DaemonGateway))
    private readonly daemonGateway: DaemonGateway,
    private readonly dataSyncService: DataSyncService,
  ) {}

  /**
   * 根据项目路径获取会话列表（分页）
   */
  async getSessionsByProjectPath(projectPath: string, limit = 50, offset = 0): Promise<ApiResponse<{
    sessions: any[];
    total: number;
    hasMore: boolean;
  }>> {
    this.logger.log(`📋 获取会话列表: ${projectPath}, limit=${limit}, offset=${offset}`);

    const result = await this.daemonGateway.requestSessions(projectPath, limit, offset);

    if (!result) {
      this.logger.warn('Daemon 离线，无法获取会话列表');
      return { status: 'offline', message: 'Daemon not connected' };
    }

    this.logger.log(`✅ 返回 ${result.sessions.length} 个会话 (total=${result.total})`);
    return { status: 'ok', data: result };
  }

  /**
   * 根据项目 ID 获取会话列表（已废弃）
   * @deprecated 请使用 getSessionsByProjectPath
   */
  async getSessionsByProject(projectId: number): Promise<ApiResponse<any[]>> {
    this.logger.warn(`⚠️ getSessionsByProject(${projectId}) 已废弃，V4 不再支持 numeric ID`);
    return { status: 'error', message: 'getSessionsByProject is deprecated, use getSessionsByProjectPath instead' };
  }

  /**
   * 根据 session_id 获取会话详情
   * 注意：需要同时提供 projectPath 以便 Daemon 查找
   */
  async getSessionBySessionId(sessionId: string, projectPath?: string): Promise<ApiResponse<any>> {
    this.logger.log(`📋 获取会话详情: ${sessionId}`);

    if (!projectPath) {
      this.logger.warn('缺少 projectPath 参数');
      return { status: 'error', message: 'projectPath is required' };
    }

    const result = await this.daemonGateway.requestSessionBySessionId(sessionId, projectPath);

    if (result === null) {
      this.logger.warn('Daemon 离线或会话不存在');
      return { status: 'offline', message: 'Daemon not connected or session not found' };
    }

    return { status: 'ok', data: result };
  }

  /**
   * 根据 ID 获取会话（已废弃）
   * @deprecated 请使用 getSessionBySessionId
   */
  async getSessionById(id: number): Promise<ApiResponse<any>> {
    this.logger.warn(`⚠️ getSessionById(${id}) 已废弃，V4 不再支持 numeric ID`);
    return { status: 'error', message: 'getSessionById is deprecated, use getSessionBySessionId instead' };
  }

  /**
   * 获取会话消息（分页）
   *
   * V5 (Phase 3) 行为:
   * - forward 模式: 透传到 Daemon，由 Daemon 读取 JSONL 文件
   * - sync 模式: 并行读 Server DB + 请求 Daemon
   *   - 先返回 DB 数据（快速响应）
   *   - 同时请求 Daemon 获取最新数据
   *   - 有增量则写入 DB 并通过 WebSocket 推送
   */
  async getSessionMessages(
    sessionId: string,
    projectPath: string,
    limit = 50,
    offset = 0,
    order: 'asc' | 'desc' = 'asc',
  ): Promise<ApiResponse<{
    messages: any[];
    total: number;
    hasMore: boolean;
  }>> {
    this.logger.log(`📋 获取会话消息: ${sessionId}, limit=${limit}, offset=${offset}, order=${order}`);
    this.logger.log(`   同步模式: ${this.dataSyncService.getSyncMode()}`);

    // forward 模式：直接透传到 Daemon
    if (this.dataSyncService.isForwardMode()) {
      const result = await this.daemonGateway.requestSessionMessages(
        sessionId,
        projectPath,
        limit,
        offset,
        order,
      );

      if (!result) {
        this.logger.warn('Daemon 离线，无法获取会话消息');
        return { status: 'offline', message: 'Daemon not connected' };
      }

      this.logger.log(`✅ 返回 ${result.messages.length} 条消息 (total=${result.total})`);
      return { status: 'ok', data: result, source: 'daemon' };
    }

    // sync 模式：先读 DB（快速响应），同时请求 Daemon（后台刷新）
    // 关键：不使用 Promise.all，避免 Daemon 超时阻塞 DB 响应

    // 1. 先尝试读 DB 缓存（毫秒级）
    const dbResult = await this.dataSyncService.getMessagesFromDb(sessionId, limit, offset, order);

    // 2. 后台请求 Daemon 并同步（不阻塞返回）
    this.daemonGateway.requestSessionMessages(sessionId, projectPath, limit, offset, order)
      .then((daemonResult) => {
        if (daemonResult && daemonResult.messages.length > 0) {
          // 后台同步到 DB
          this.syncMessagesToDb(sessionId, projectPath, daemonResult.messages).catch((err) => {
            this.logger.error(`❌ 后台同步失败: ${err.message}`);
          });
          // TODO: 如果有增量，可以通过 WebSocket 推送给订阅的客户端
        }
      })
      .catch((err) => {
        this.logger.warn(`⚠️ 后台请求 Daemon 失败: ${err.message}`);
      });

    // 3. 有 DB 缓存则立即返回
    if (dbResult && dbResult.messages.length > 0) {
      this.logger.log(`✅ 返回 DB 缓存: ${dbResult.messages.length} 条消息（后台刷新中）`);
      return { status: 'ok', data: dbResult, source: 'db' };
    }

    // 4. DB 无缓存，需要等待 Daemon 响应
    this.logger.log(`📥 DB 无缓存，等待 Daemon 响应...`);
    const daemonResult = await this.daemonGateway.requestSessionMessages(
      sessionId,
      projectPath,
      limit,
      offset,
      order,
    );

    if (daemonResult) {
      this.logger.log(`✅ 返回 Daemon 数据: ${daemonResult.messages.length} 条消息`);

      // 同步到 DB（不阻塞响应）
      this.syncMessagesToDb(sessionId, projectPath, daemonResult.messages).catch((err) => {
        this.logger.error(`❌ 同步失败: ${err.message}`);
      });

      return { status: 'ok', data: daemonResult, source: 'daemon' };
    }

    // 都没有数据
    this.logger.warn('Daemon 离线且 DB 无缓存');
    return { status: 'offline', message: 'Daemon not connected and no cached data' };
  }

  /**
   * 后台同步消息到 DB（sync 模式使用）
   */
  private async syncMessagesToDb(
    sessionId: string,
    projectPath: string,
    messages: any[],
  ): Promise<void> {
    if (!this.dataSyncService.isSyncMode()) {
      return;
    }

    try {
      // 确保 Project 和 Session 存在
      const projectId = await this.dataSyncService.ensureProject(projectPath);
      const sessionDbId = await this.dataSyncService.ensureSession(sessionId, projectId, projectPath);

      // 转换消息格式并同步
      const daemonMessages: DaemonMessage[] = messages.map((msg) => ({
        uuid: msg.uuid || `${sessionId}-${msg.sequence}`,
        role: msg.role,
        content: msg.content,
        metadata: msg.metadata,
        sequence: msg.sequence,
        timestamp: msg.timestamp,
        toolCallId: msg.toolCallId,
        approvalStatus: msg.approvalStatus,
        approvalResolvedAt: msg.approvalResolvedAt,
      }));

      await this.dataSyncService.syncMessages(sessionDbId, daemonMessages);
    } catch (error) {
      this.logger.error(`❌ syncMessagesToDb 失败: ${error.message}`);
    }
  }

  /**
   * 创建会话（不支持，只读数据源）
   */
  async createSession(projectPath: string, prompt?: string, requestId?: string) {
    throw new Error('Daemon 数据是只读的，不支持创建会话。请使用 ETerm 创建会话。');
  }

  /**
   * 删除会话（不支持，只读数据源）
   */
  async deleteSession(id: number) {
    throw new Error('Daemon 数据是只读的，不支持删除操作');
  }
}
