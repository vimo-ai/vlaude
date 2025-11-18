/**
 * @description Project Controller - 项目列表 API
 * @author Claude
 * @date 2025/11/16
 * @version v2.0.0
 *
 * V2 架构: 直接从文件系统读取项目数据，不依赖数据库
 * 数据优先级: 文件系统 > 数据库
 */
import { Controller, Get, Query, Logger, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { DataCollectorService } from '../../module/data-collector/data-collector.service';

@Controller('projects')
export class ProjectController {
  private readonly logger = new Logger(ProjectController.name);

  constructor(private readonly dataCollector: DataCollectorService) {}

  /**
   * 获取项目列表 (从文件系统实时读取)
   * GET /projects?limit=10
   *
   * @param limit 返回的项目数量，默认 10
   * @returns 按最新 session mtime 排序的项目列表（只包含轻量级元数据）
   */
  @Get()
  async getProjects(
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    try {
      this.logger.log(`📋 收到项目列表请求，limit=${limit}`);

      // 从文件系统读取项目 (按 mtime 排序，返回最新的 limit 个)
      const projects = await this.dataCollector.collectProjects(limit);

      // 只返回轻量级元数据（用于 Server 端对比 mtime）
      const lightweightProjects = projects.map(p => ({
        name: p.name,
        path: p.path,
        encodedDirName: p.encodedDirName,  // V2: 返回编码的目录名
        lastMtime: p.lastAccessed,  // 最新 session 的 mtime
        sessionCount: p.sessions.length,
      }));

      this.logger.log(`✅ 返回 ${lightweightProjects.length} 个项目`);

      return {
        success: true,
        data: lightweightProjects,
        total: lightweightProjects.length,
        source: 'filesystem', // 标识数据来自文件系统
      };
    } catch (error) {
      this.logger.error(`❌ 获取项目列表失败: ${error.message}`);
      return {
        success: false,
        message: error.message,
        data: [],
      };
    }
  }
}
