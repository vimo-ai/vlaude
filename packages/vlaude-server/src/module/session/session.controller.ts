/**
 * @description Session Controller - 会话管理 API
 * @author Claude
 * @date 2025/01/09
 * @version v4.0.0
 *
 * V4 架构改进:
 * - 适配 ApiResponse 格式
 * - 返回 status 字段区分离线和空数据
 * - getSessionMessages 需要 projectPath 参数
 */
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { SessionService } from './session.service';
import { DaemonGateway } from '../daemon-gateway/daemon.gateway';

@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    @Inject(forwardRef(() => DaemonGateway))
    private readonly daemonGateway: DaemonGateway,
  ) {}

  /**
   * 序列化会话数据
   * 注意：Rust Daemon 返回 `id` 字段，需要兼容两种字段名
   */
  private async serializeSession(session: any): Promise<any> {
    if (!session) return session;
    // Rust SessionMeta 使用 `id`，兼容旧格式的 `sessionId`
    const sessionId = session.sessionId || session.id;
    return {
      ...session,
      // 统一输出 sessionId 供 iOS 端使用
      sessionId,
      lastFileSize: session.lastFileSize?.toString(),
      inEterm: await this.daemonGateway.isSessionInEterm(sessionId),
    };
  }

  /**
   * 序列化会话数组
   */
  private async serializeSessions(sessions: any[]): Promise<any[]> {
    return Promise.all(sessions.map(s => this.serializeSession(s)));
  }

  /**
   * 创建新对话（不支持，Daemon 数据只读）
   * POST /sessions
   */
  @Post()
  async createSession(
    @Body() body: { projectPath: string; prompt?: string; requestId?: string }
  ) {
    return {
      success: false,
      message: 'Daemon 数据是只读的，请使用 ETerm 创建会话',
    };
  }

  /**
   * 获取项目的会话列表 (V4: 从 Daemon 代理获取)
   * GET /sessions/by-path?path=/xxx&limit=20&offset=0
   */
  @Get('by-path')
  async getSessionsByPath(
    @Query('path') projectPath: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (!projectPath) {
      return {
        success: false,
        message: '缺少 path 参数',
        data: [],
      };
    }

    const limitNum = limit ? parseInt(limit, 10) : 20;
    const offsetNum = offset ? parseInt(offset, 10) : 0;
    const result = await this.sessionService.getSessionsByProjectPath(projectPath, limitNum, offsetNum);

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
      };
    }

    return {
      success: true,
      status: 'ok',
      data: await this.serializeSessions(result.data!.sessions),
      total: result.data!.total,
      hasMore: result.data!.hasMore,
      etermOnline: await this.daemonGateway.isEtermOnline(),
    };
  }

  /**
   * 根据 sessionId 获取会话详情
   * GET /sessions/by-session-id/:sessionId?projectPath=/xxx
   * 注意：V4 需要 projectPath 参数
   */
  @Get('by-session-id/:sessionId')
  async getSessionBySessionId(
    @Param('sessionId') sessionId: string,
    @Query('projectPath') projectPath?: string,
  ) {
    const result = await this.sessionService.getSessionBySessionId(sessionId, projectPath);

    if (result.status !== 'ok') {
      return {
        success: false,
        status: result.status,
        message: result.message || '会话不存在',
      };
    }

    return {
      success: true,
      status: 'ok',
      data: await this.serializeSession(result.data),
    };
  }

  /**
   * 获取项目的所有会话列表 (已废弃)
   * GET /sessions/by-project/:projectId
   * @deprecated 请使用 /sessions/by-path?path=xxx
   */
  @Get('by-project/:projectId')
  async getSessionsByProject(
    @Param('projectId', ParseIntPipe) projectId: number,
  ) {
    const result = await this.sessionService.getSessionsByProject(projectId);

    if (result.status !== 'ok') {
      return {
        success: false,
        status: result.status,
        message: result.message,
        data: [],
        total: 0,
      };
    }

    return {
      success: true,
      status: 'ok',
      data: [],
      total: 0,
      message: '此接口已废弃，请使用 /sessions/by-path?path=xxx',
    };
  }

  /**
   * 分页获取会话消息
   * GET /sessions/:sessionId/messages?projectPath=/xxx&limit=50&offset=0&order=asc
   * 注意：V4 需要 projectPath 参数
   */
  @Get(':sessionId/messages')
  async getSessionMessages(
    @Param('sessionId') sessionId: string,
    @Query('projectPath') projectPath: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('order', new DefaultValuePipe('asc')) order: 'asc' | 'desc',
  ) {
    if (!projectPath) {
      return {
        success: false,
        message: '缺少 projectPath 参数',
      };
    }

    const result = await this.sessionService.getSessionMessages(
      sessionId,
      projectPath,
      limit,
      offset,
      order,
    );

    if (result.status !== 'ok') {
      return {
        success: false,
        status: result.status,
        message: result.message || '会话不存在',
      };
    }

    return {
      success: true,
      status: 'ok',
      data: result.data!.messages,
      total: result.data!.total,
      hasMore: result.data!.hasMore,
    };
  }

  /**
   * 根据 ID 获取会话详情（已废弃）
   * GET /sessions/:id
   * @deprecated 请使用 /sessions/by-session-id/:sessionId
   */
  @Get(':id')
  async getSessionById(@Param('id', ParseIntPipe) id: number) {
    const result = await this.sessionService.getSessionById(id);

    if (result.status !== 'ok') {
      return {
        success: false,
        status: result.status,
        message: result.message || '会话不存在',
      };
    }

    return {
      success: true,
      status: 'ok',
      data: await this.serializeSession(result.data),
    };
  }

  /**
   * 删除会话（不支持）
   * DELETE /sessions/:id
   */
  @Delete(':id')
  async deleteSession(@Param('id', ParseIntPipe) id: number) {
    try {
      await this.sessionService.deleteSession(id);
      return {
        success: true,
        message: '会话已删除',
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  }
}
