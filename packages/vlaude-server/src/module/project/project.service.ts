/**
 * @description Project Service - 项目数据管理
 * @author Claude
 * @date 2025/12/31
 * @version v3.0.0
 *
 * V3 架构改进:
 * - 唯一数据源: SharedDbService (ai-cli-session.db)
 * - 移除 Prisma (MySQL) 和 Daemon 依赖
 * - 简化架构，直接读取 SQLite
 */
import { Injectable, Logger } from '@nestjs/common';
import { SharedDbService, SharedProject } from '../../shared-db/shared-db.service';

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(private readonly sharedDb: SharedDbService) {}

  /**
   * 获取项目列表（分页）
   */
  async getAllProjects(limit: number = 10, offset: number = 0) {
    this.logger.log(`📋 获取项目列表，limit=${limit}, offset=${offset}`);

    if (!this.sharedDb.isAvailable()) {
      this.logger.warn('SharedDb 不可用');
      return { projects: [], total: 0, hasMore: false };
    }

    const result = this.sharedDb.getAllProjects(limit, offset);
    const hasMore = offset + result.projects.length < result.total;

    this.logger.log(`✅ 返回 ${result.projects.length} 个项目 (total=${result.total})`);

    // 转换为 API 格式
    const projects = result.projects.map(p => this.mapProject(p));

    return { projects, total: result.total, hasMore };
  }

  /**
   * 根据 ID 获取项目
   */
  async getProjectById(id: number) {
    if (!this.sharedDb.isAvailable()) {
      return null;
    }

    const project = this.sharedDb.getProjectById(id);
    if (!project) {
      return null;
    }

    // 获取会话列表
    const sessions = this.sharedDb.getSessionsByProjectId(id);

    return {
      ...this.mapProject(project),
      sessions: sessions.map(s => ({
        id: s.id,
        sessionId: s.session_id,
        messageCount: s.message_count,
        lastMessageAt: s.last_message_at ? new Date(s.last_message_at).toISOString() : null,
        createdAt: new Date(s.created_at).toISOString(),
        updatedAt: new Date(s.updated_at).toISOString(),
      })),
    };
  }

  /**
   * 根据路径获取项目
   */
  async getProjectByPath(path: string) {
    if (!this.sharedDb.isAvailable()) {
      return null;
    }

    const project = this.sharedDb.getProjectByPath(path);
    if (!project) {
      return null;
    }

    const sessions = this.sharedDb.getSessionsByProjectPath(path);

    return {
      ...this.mapProject(project),
      sessions: sessions.map(s => ({
        id: s.id,
        sessionId: s.session_id,
        messageCount: s.message_count,
        lastMessageAt: s.last_message_at ? new Date(s.last_message_at).toISOString() : null,
        createdAt: new Date(s.created_at).toISOString(),
        updatedAt: new Date(s.updated_at).toISOString(),
      })),
    };
  }

  /**
   * 删除项目（不支持，只读数据源）
   */
  async deleteProject(id: number) {
    throw new Error('SharedDb 是只读数据源，不支持删除操作');
  }

  /**
   * 转换项目数据格式
   * 兼容 iOS Vlaude Project 模型
   */
  private mapProject(p: SharedProject) {
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      source: p.source,
      // iOS 期望的可选字段
      encodedDirName: null,
      lastAccessed: null,
      createdAt: new Date(p.created_at).toISOString(),
      updatedAt: new Date(p.updated_at).toISOString(),
    };
  }
}
