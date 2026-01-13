/**
 * @description Project Controller - 项目管理 API
 * @author Claude
 * @date 2025/01/09
 * @version v4.0.0
 *
 * V4 架构改进:
 * - 适配 ApiResponse 格式
 * - 返回 status 字段区分离线和空数据
 */
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  ParseIntPipe,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ProjectService } from './project.service';
import { DaemonGateway } from '../daemon-gateway/daemon.gateway';

@Controller('projects')
export class ProjectController {
  constructor(
    private readonly projectService: ProjectService,
    @Inject(forwardRef(() => DaemonGateway))
    private readonly daemonGateway: DaemonGateway,
  ) {}

  /**
   * 序列化项目数据（处理嵌套的 sessions 中的 BigInt）
   */
  private serializeProject(project: any) {
    if (!project) return project;
    return {
      ...project,
      sessions: project.sessions?.map(s => ({
        ...s,
        lastFileSize: s.lastFileSize?.toString(),
      })),
    };
  }

  /**
   * 序列化项目数组
   */
  private serializeProjects(projects: any[]) {
    return projects.map(p => this.serializeProject(p));
  }

  /**
   * 获取项目列表 (V4: 从 Daemon 代理获取)
   * GET /projects?limit=10&offset=0
   */
  @Get()
  async getAllProjects(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const offsetNum = offset ? parseInt(offset, 10) : 0;
    const result = await this.projectService.getAllProjects(limitNum, offsetNum);

    // V4: 处理 ApiResponse 格式
    if (result.status !== 'ok') {
      return {
        success: false,
        status: result.status,
        message: result.message,
        data: [],
        total: 0,
        hasMore: false,
        etermOnline: false,
        etermSessions: [],
      };
    }

    return {
      success: true,
      status: 'ok',
      data: this.serializeProjects(result.data!.projects),
      total: result.data!.total,
      hasMore: result.data!.hasMore,
      etermOnline: await this.daemonGateway.isEtermOnline(),
      etermSessions: await this.daemonGateway.getEtermSessions(),
    };
  }

  /**
   * 根据 ID 获取项目详情（已废弃）
   * GET /projects/:id
   * @deprecated 请使用 /projects/by-path/search?path=xxx
   */
  @Get(':id')
  async getProjectById(@Param('id', ParseIntPipe) id: number) {
    const result = await this.projectService.getProjectById(id);

    if (result.status !== 'ok') {
      return {
        success: false,
        status: result.status,
        message: result.message || '项目不存在',
      };
    }

    return {
      success: true,
      status: 'ok',
      data: this.serializeProject(result.data),
    };
  }

  /**
   * 根据路径获取项目
   * GET /projects/by-path/search?path=/xxx
   */
  @Get('by-path/search')
  async getProjectByPath(@Query('path') path: string) {
    if (!path) {
      return {
        success: false,
        message: '缺少 path 参数',
      };
    }

    const result = await this.projectService.getProjectByPath(path);

    if (result.status !== 'ok') {
      return {
        success: false,
        status: result.status,
        message: result.message || '项目不存在',
      };
    }

    return {
      success: true,
      status: 'ok',
      data: this.serializeProject(result.data),
    };
  }

  /**
   * 删除项目（不支持）
   * DELETE /projects/:id
   */
  @Delete(':id')
  async deleteProject(@Param('id', ParseIntPipe) id: number) {
    try {
      await this.projectService.deleteProject(id);
      return {
        success: true,
        message: '项目已删除',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  }
}
