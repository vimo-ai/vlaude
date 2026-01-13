/**
 * @description Project Service - 项目数据管理
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
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(
    @Inject(forwardRef(() => DaemonGateway))
    private readonly daemonGateway: DaemonGateway,
  ) {}

  /**
   * 获取项目列表（分页）
   */
  async getAllProjects(limit: number = 50, offset: number = 0): Promise<ApiResponse<{
    projects: any[];
    total: number;
    hasMore: boolean;
  }>> {
    this.logger.log(`📋 获取项目列表，limit=${limit}, offset=${offset}`);

    const result = await this.daemonGateway.requestProjects(limit, offset);

    if (!result) {
      this.logger.warn('Daemon 离线，无法获取项目列表');
      return { status: 'offline', message: 'Daemon not connected' };
    }

    this.logger.log(`✅ 返回 ${result.projects.length} 个项目 (total=${result.total})`);
    return { status: 'ok', data: result };
  }

  /**
   * 根据路径获取项目
   */
  async getProjectByPath(path: string): Promise<ApiResponse<any>> {
    this.logger.log(`📋 获取项目详情: ${path}`);

    const result = await this.daemonGateway.requestProjectByPath(path);

    if (result === null) {
      // null 可能是 Daemon 离线，也可能是项目不存在
      // 这里统一返回 offline，让前端重试
      this.logger.warn('Daemon 离线或项目不存在');
      return { status: 'offline', message: 'Daemon not connected or project not found' };
    }

    return { status: 'ok', data: result };
  }

  /**
   * 根据 ID 获取项目（已废弃，V4 不再支持 numeric ID）
   * @deprecated 请使用 getProjectByPath
   */
  async getProjectById(id: number): Promise<ApiResponse<any>> {
    this.logger.warn(`⚠️ getProjectById(${id}) 已废弃，V4 不再支持 numeric ID`);
    return { status: 'error', message: 'getProjectById is deprecated, use getProjectByPath instead' };
  }

  /**
   * 删除项目（不支持，只读数据源）
   */
  async deleteProject(id: number) {
    throw new Error('Daemon 数据是只读的，不支持删除操作');
  }
}
