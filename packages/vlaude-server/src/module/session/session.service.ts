/**
 * @description Session Service - 会话数据管理
 * @author Claude
 * @date 2025/01/09
 * @version v4.0.0
 *
 * V4 架构改进:
 * - 纯代理模式: 所有请求透传到 Daemon
 * - 移除 SharedDbService (SQLite) 依赖
 * - Server 可部署到云端/NAS
 * - 返回 status 字段区分离线和空数据
 */
import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { DaemonGateway } from '../daemon-gateway/daemon.gateway';

// API 响应类型
interface ApiResponse<T> {
  status: 'ok' | 'offline' | 'error';
  data?: T;
  message?: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(forwardRef(() => DaemonGateway))
    private readonly daemonGateway: DaemonGateway,
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
   * 透传到 Daemon，由 Daemon 读取 JSONL 文件
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
    return { status: 'ok', data: result };
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
