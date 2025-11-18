/**
 * @description Project Controller - 项目管理 API
 * @author Claude
 * @date 2025/11/16
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
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
} from '@nestjs/common';
import { ProjectService } from './project.service';

@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

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
   * 获取项目列表 (V2: 从文件系统获取 + 增量更新 + 分页支持)
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
    return {
      success: true,
      data: this.serializeProjects(result.projects),
      total: result.total,
      hasMore: result.hasMore,
    };
  }

  /**
   * 根据 ID 获取项目详情
   * GET /projects/:id
   */
  @Get(':id')
  async getProjectById(@Param('id', ParseIntPipe) id: number) {
    const project = await this.projectService.getProjectById(id);

    if (!project) {
      return {
        success: false,
        message: '项目不存在',
      };
    }

    return {
      success: true,
      data: this.serializeProject(project),
    };
  }

  /**
   * 根据路径获取项目
   * GET /projects/by-path?path=/xxx
   */
  @Get('by-path/search')
  async getProjectByPath(@Query('path') path: string) {
    if (!path) {
      return {
        success: false,
        message: '缺少 path 参数',
      };
    }

    const project = await this.projectService.getProjectByPath(path);

    if (!project) {
      return {
        success: false,
        message: '项目不存在',
      };
    }

    return {
      success: true,
      data: this.serializeProject(project),
    };
  }

  /**
   * 删除项目
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
