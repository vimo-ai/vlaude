/**
 * @description Session Controller - 会话管理 API
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
   * 注意：现在从 Redis 读取 inEterm 状态，已改为 async
   *
   * @see docs/DATA_STRUCTURE_SYNC.md#3-session-模型-ineterm-字段
   * @see Vlaude/Models/Session.swift - iOS 端 Session 定义
   */
  private async serializeSession(session: any): Promise<any> {
    if (!session) return session;
    return {
      ...session,
      lastFileSize: session.lastFileSize?.toString(),
      // 标记该 session 是否在 ETerm 中打开
      // @see docs/DATA_STRUCTURE_SYNC.md#3-session-模型-ineterm-字段
      inEterm: await this.daemonGateway.isSessionInEterm(session.sessionId),
    };
  }

  /**
   * 序列化会话数组
   * 注意：使用 Promise.all 并行处理
   */
  private async serializeSessions(sessions: any[]): Promise<any[]> {
    return Promise.all(sessions.map(s => this.serializeSession(s)));
  }

  /**
   * 创建新对话（暂不支持，SharedDb 只读）
   * POST /sessions
   */
  @Post()
  async createSession(
    @Body() body: { projectPath: string; prompt?: string; requestId?: string }
  ) {
    return {
      success: false,
      message: 'SharedDb 是只读数据源，暂不支持创建会话',
    };
  }

  /**
   * 获取项目的会话列表 (V2: 从文件系统获取 + 分页支持)
   * GET /sessions/by-path?path=/xxx&limit=20&offset=0
   *
   * 注意：此路由必须在 :id 等动态路由之前，否则会被 :id 路由匹配
   *
   * @see docs/DATA_STRUCTURE_SYNC.md#2-sessionlistresponse
   * @see Vlaude/Models/Session.swift - iOS 端 SessionListResponse 定义
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

    return {
      success: true,
      data: await this.serializeSessions(result.sessions),
      total: result.total,
      hasMore: result.hasMore,
      // ETerm 在线状态（解决时序问题）
      // @see docs/DATA_STRUCTURE_SYNC.md#2-sessionlistresponse
      etermOnline: await this.daemonGateway.isEtermOnline(),
    };
  }

  /**
   * 根据 sessionId 获取会话详情
   * GET /sessions/by-session-id/:sessionId
   *
   * 注意：此路由必须在 :id 等动态路由之前
   */
  @Get('by-session-id/:sessionId')
  async getSessionBySessionId(@Param('sessionId') sessionId: string) {
    const session = await this.sessionService.getSessionBySessionId(sessionId);

    if (!session) {
      return {
        success: false,
        message: '会话不存在',
      };
    }

    return {
      success: true,
      data: await this.serializeSession(session),
    };
  }

  /**
   * 获取项目的所有会话列表 (已废弃，使用 /sessions/by-path)
   * GET /sessions/by-project/:projectId
   *
   * 注意：此路由必须在 :id 等动态路由之前
   */
  @Get('by-project/:projectId')
  async getSessionsByProject(
    @Param('projectId', ParseIntPipe) projectId: number,
  ) {
    const sessions = await this.sessionService.getSessionsByProject(projectId);

    return {
      success: true,
      data: await this.serializeSessions(sessions),
      total: sessions.length,
    };
  }

  /**
   * 分页获取会话消息
   * GET /sessions/:sessionId/messages?limit=50&offset=0&order=asc
   */
  @Get(':sessionId/messages')
  async getSessionMessages(
    @Param('sessionId') sessionId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('order', new DefaultValuePipe('asc')) order: 'asc' | 'desc',
  ) {
    const result = await this.sessionService.getSessionMessages(
      sessionId,
      limit,
      offset,
      order,
    );

    if (!result) {
      return {
        success: false,
        message: '会话不存在',
      };
    }

    return {
      success: true,
      data: result.messages,
      total: result.total,
      hasMore: result.hasMore,
    };
  }

  /**
   * 根据 ID 获取会话详情（包含所有消息）
   * GET /sessions/:id
   *
   * 注意：动态路由（如 :id）必须放在最后，否则会拦截其他具体路由
   */
  @Get(':id')
  async getSessionById(@Param('id', ParseIntPipe) id: number) {
    const session = await this.sessionService.getSessionById(id);

    if (!session) {
      return {
        success: false,
        message: '会话不存在',
      };
    }

    return {
      success: true,
      data: await this.serializeSession(session),
    };
  }

  /**
   * 删除会话
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
