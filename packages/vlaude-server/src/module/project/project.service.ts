/**
 * @description Project Service - 项目数据管理
 * @author Claude
 * @date 2025/11/16
 * @version v2.0.0
 *
 * V2 架构改进:
 * 1. 数据优先级: 文件系统 > 数据库
 * 2. 增量更新策略: 对比 mtime，只更新变化的项目 (3新7旧)
 * 3. 数据库作为缓存，用于加速查询
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { ConfigService } from '@nestjs/config';

interface ProjectData {
  name: string;
  path: string;
  lastAccessed: Date;
  sessions: string[];
}

// Daemon 返回的轻量级项目元数据
interface DaemonProjectMetadata {
  name: string;
  path: string;
  encodedDirName: string;  // V2: Claude 编码的目录名
  lastMtime: string;  // ISO 格式的时间字符串
  sessionCount: number;
}

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);
  private readonly daemonBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    // 从环境变量读取 Daemon 地址
    const daemonPort = this.config.get<number>('DAEMON_PORT', 10006);
    this.daemonBaseUrl = `http://localhost:${daemonPort}`;
  }

  /**
   * 批量保存或更新项目数据
   */
  async saveProjects(projects: ProjectData[], daemonId: string) {
    this.logger.log(`保存 ${projects.length} 个项目数据，来自 daemon ${daemonId}`);

    for (const projectData of projects) {
      try {
        // 使用 upsert 实现插入或更新
        await this.prisma.project.upsert({
          where: {
            path: projectData.path,
          },
          update: {
            name: projectData.name,
            lastAccessed: projectData.lastAccessed,
            updatedAt: new Date(),
          },
          create: {
            name: projectData.name,
            path: projectData.path,
            lastAccessed: projectData.lastAccessed,
          },
        });

        this.logger.debug(`项目已保存: ${projectData.name}`);
      } catch (error) {
        this.logger.error(
          `保存项目失败 ${projectData.name}: ${error.message}`,
        );
      }
    }
  }

  /**
   * 获取项目列表 (V2: 从文件系统获取 + 增量更新数据库 + 分页支持)
   * @param limit 返回项目数量，默认 10
   * @param offset 偏移量，默认 0
   * @returns 按最新 mtime 排序的项目列表 + 分页信息
   */
  async getAllProjects(limit: number = 10, offset: number = 0) {
    try {
      this.logger.log(`📋 获取项目列表，limit=${limit}, offset=${offset}`);

      // 1. 从 Daemon 获取文件系统的项目元数据
      const daemonProjects = await this.fetchProjectsFromDaemon(limit, offset);

      if (daemonProjects.length === 0) {
        this.logger.warn('Daemon 未返回任何项目');
        const total = await this.prisma.project.count({
          where: { isDeleted: false },
        });
        return { projects: [], total, hasMore: false };
      }

      this.logger.log(`📦 Daemon 返回 ${daemonProjects.length} 个项目`);

      // 2. 增量更新策略：对比 mtime，识别新/旧项目
      const { newProjects, unchangedProjects } = await this.categorizeProjects(daemonProjects);

      this.logger.log(`🆕 新项目: ${newProjects.length} 个, 📦 未变化: ${unchangedProjects.length} 个`);

      // 3. 对于新项目，更新数据库缓存
      await this.updateProjectCache(newProjects);

      // 4. 从数据库查询完整数据（不包含 sessions,项目列表页面不需要）
      const projectPaths = daemonProjects.map(p => p.path);
      const projects = await this.prisma.project.findMany({
        where: {
          path: { in: projectPaths },
          isDeleted: false,
        },
        orderBy: {
          lastModified: 'desc',
        },
      });

      // 5. 获取总数并判断是否还有更多
      const total = await this.prisma.project.count({
        where: { isDeleted: false },
      });
      const hasMore = offset + projects.length < total;

      this.logger.log(`✅ 返回 ${projects.length} 个项目 (offset=${offset}, total=${total}, hasMore=${hasMore})`);
      return { projects, total, hasMore };

    } catch (error) {
      this.logger.error(`获取项目列表失败: ${error.message}`);
      // 降级方案：如果 Daemon 不可用，从数据库读取
      const projects = await this.prisma.project.findMany({
        where: { isDeleted: false },
        orderBy: { lastModified: 'desc' },
        skip: offset,
        take: limit,
      });
      const total = await this.prisma.project.count({
        where: { isDeleted: false },
      });
      const hasMore = offset + projects.length < total;
      return { projects, total, hasMore };
    }
  }

  /**
   * 从 Daemon 获取项目元数据
   */
  private async fetchProjectsFromDaemon(limit: number, offset: number = 0): Promise<DaemonProjectMetadata[]> {
    try {
      const url = `${this.daemonBaseUrl}/projects?limit=${limit}&offset=${offset}`;
      this.logger.debug(`🔗 调用 Daemon API: ${url}`);

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Daemon API 返回错误: ${response.status}`);
      }

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.message || 'Daemon 返回失败');
      }

      return result.data || [];
    } catch (error) {
      this.logger.error(`调用 Daemon API 失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 分类项目：识别新项目和未变化项目 (3新7旧策略)
   */
  private async categorizeProjects(daemonProjects: DaemonProjectMetadata[]) {
    const newProjects: DaemonProjectMetadata[] = [];
    const unchangedProjects: DaemonProjectMetadata[] = [];

    for (const daemonProject of daemonProjects) {
      // 从数据库查询该项目
      const dbProject = await this.prisma.project.findUnique({
        where: { path: daemonProject.path },
      });

      const daemonMtime = new Date(daemonProject.lastMtime);

      if (!dbProject) {
        // 数据库中不存在 → 新项目
        newProjects.push(daemonProject);
      } else if (!dbProject.lastModified || dbProject.lastModified < daemonMtime) {
        // mtime 更新了 → 有新对话，需要增量更新
        newProjects.push(daemonProject);
      } else {
        // mtime 没变 → 使用数据库缓存
        unchangedProjects.push(daemonProject);
      }
    }

    return { newProjects, unchangedProjects };
  }

  /**
   * 更新数据库缓存 (只更新变化的项目)
   */
  private async updateProjectCache(projects: DaemonProjectMetadata[]) {
    for (const project of projects) {
      try {
        await this.prisma.project.upsert({
          where: { path: project.path },
          update: {
            name: project.name,
            encodedDirName: project.encodedDirName,  // V2: 保存编码目录名
            lastModified: new Date(project.lastMtime),
            sessionCount: project.sessionCount,
            updatedAt: new Date(),
          },
          create: {
            name: project.name,
            path: project.path,
            encodedDirName: project.encodedDirName,  // V2: 保存编码目录名
            projectPath: project.path,  // 兼容字段
            lastModified: new Date(project.lastMtime),
            sessionCount: project.sessionCount,
          },
        });

        this.logger.debug(`✅ 项目缓存已更新: ${project.name} (encodedDirName: ${project.encodedDirName})`);
      } catch (error) {
        this.logger.error(`更新项目缓存失败 ${project.name}: ${error.message}`);
      }
    }
  }

  /**
   * 根据 ID 获取项目
   */
  async getProjectById(id: number) {
    return this.prisma.project.findUnique({
      where: { id },
      include: {
        sessions: {
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });
  }

  /**
   * 根据路径获取项目
   */
  async getProjectByPath(path: string) {
    return this.prisma.project.findUnique({
      where: { path },
      include: {
        sessions: true,
      },
    });
  }

  /**
   * 删除项目
   */
  async deleteProject(id: number) {
    return this.prisma.project.delete({
      where: { id },
    });
  }
}
