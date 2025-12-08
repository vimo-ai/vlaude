import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { ProjectService } from '../project/project.service';
import { SessionService } from '../session/session.service';
import { PrismaService } from '../../shared/database/prisma.service';

/**
 * Daemon Gateway
 * 接收来自 daemon 的 WebSocket 连接
 */
@WebSocketGateway({
  namespace: '/daemon',
  cors: {
    origin: '*',
  },
  transports: ['websocket'],
})
export class DaemonGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(DaemonGateway.name);
  private connectedDaemons = new Map<string, { socket: Socket; info: any }>();

  // ETerm 状态追踪
  private etermOnline = false;
  private etermSessions = new Set<string>(); // ETerm 中可用的 session

  constructor(
    private readonly projectService: ProjectService,
    private readonly sessionService: SessionService,
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('Daemon Gateway initialized');
  }

  handleConnection(client: Socket) {
    this.logger.log(`Daemon attempting to connect: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Daemon disconnected: ${client.id}`);
    this.connectedDaemons.delete(client.id);
  }

  /**
   * Daemon 注册
   */
  @SubscribeMessage('daemon:register')
  async handleDaemonRegister(
    @MessageBody() data: { hostname: string; platform: string; version: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Daemon registered: ${data.hostname} (${data.platform})`);

    this.connectedDaemons.set(client.id, {
      socket: client,
      info: data,
    });

    return { event: 'daemon:registered', data: { success: true } };
  }

  /**
   * 接收 daemon 发送的项目数据
   */
  @SubscribeMessage('daemon:projectData')
  async handleProjectData(
    @MessageBody() data: { projects: any[] },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Received ${data.projects.length} projects from daemon ${client.id}`);

    try {
      await this.projectService.saveProjects(data.projects, client.id);
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to save projects: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 接收 daemon 发送的会话元数据（批量）
   */
  @SubscribeMessage('daemon:sessionMetadata')
  async handleSessionMetadata(
    @MessageBody() data: { projectPath: string; sessions: any[] },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(
      `Received ${data.sessions.length} session metadata for project ${data.projectPath} from daemon ${client.id}`,
    );

    try {
      await this.sessionService.saveSessionMetadata(
        data.projectPath,
        data.sessions,
      );
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to save session metadata: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 向指定 daemon 发送指令
   */
  sendCommandToDaemon(daemonId: string, command: string, data: any) {
    const daemon = this.connectedDaemons.get(daemonId);
    if (daemon) {
      daemon.socket.emit('server:command', { command, data });
      this.logger.log(`Sent command ${command} to daemon ${daemonId}`);
    }
  }

  /**
   * 广播指令到所有 daemon
   */
  broadcastCommand(command: string, data: any) {
    this.server.emit('server:command', { command, data });
    this.logger.log(`Broadcasted command ${command} to all daemons`);
  }

  /**
   * 获取所有已连接的 daemon
   */
  getConnectedDaemons() {
    return Array.from(this.connectedDaemons.entries()).map(([id, daemon]) => ({
      id,
      info: daemon.info,
    }));
  }

  /**
   * 请求 daemon 读取会话消息
   * @param sessionId 会话ID
   * @param projectPath 项目路径
   * @param limit 每页条数
   * @param offset 偏移量
   * @param order 排序方式：'asc' 正序（旧到新），'desc' 倒序（新到旧）
   * @returns Promise<{ messages: any[]; total: number; hasMore: boolean } | null>
   */
  async requestSessionMessages(
    sessionId: string,
    projectPath: string,
    limit: number = 50,
    offset: number = 0,
    order: 'asc' | 'desc' = 'asc',
  ): Promise<{ messages: any[]; total: number; hasMore: boolean } | null> {
    // 获取第一个连接的 daemon（后续可以优化为根据项目路径选择特定 daemon）
    const daemons = Array.from(this.connectedDaemons.values());

    if (daemons.length === 0) {
      this.logger.warn('No daemon connected, cannot request session messages');
      return null;
    }

    const daemon = daemons[0]; // 使用第一个连接的 daemon

    // V2: 只传递 projectPath，Daemon 内部查表
    return new Promise((resolve) => {
      // 设置超时（10秒）
      const timeout = setTimeout(() => {
        this.logger.error(`Request session messages timeout for ${sessionId}`);
        resolve(null);
      }, 10000);

      daemon.socket.emit(
        'server:requestSessionMessages',
        { sessionId, projectPath, limit, offset, order },
        (response: { success: boolean; messages?: any[]; total?: number; hasMore?: boolean; error?: string }) => {
          clearTimeout(timeout);

          if (response.success && response.messages) {
            this.logger.log(
              `Received ${response.messages.length} messages for session ${sessionId} (total: ${response.total})`,
            );
            resolve({
              messages: response.messages,
              total: response.total || 0,
              hasMore: response.hasMore || false,
            });
          } else {
            this.logger.error(`Failed to get session messages: ${response.error || 'Unknown error'}`);
            resolve(null);
          }
        },
      );
    });
  }

  /**
   * Daemon 推送新消息（转发给 AppGateway）
   */
  @SubscribeMessage('daemon:newMessage')
  handleNewMessage(
    @MessageBody() data: { sessionId: string; message: any },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Received new message for session ${data.sessionId} from daemon ${client.id}`);

    // 通过事件转发给 AppGateway，推送到订阅了该会话的 Swift 客户端
    this.eventEmitter.emit('app.notifyNewMessage', data);
  }

  /**
   * Daemon 推送 Metrics 更新（转发给 AppGateway）
   */
  @SubscribeMessage('daemon:metricsUpdate')
  handleMetricsUpdate(
    @MessageBody() data: { sessionId: string; metrics: any },
    @ConnectedSocket() client: Socket,
  ) {
    // 通过事件转发给 AppGateway，推送到订阅了该会话的 Swift 客户端
    this.eventEmitter.emit('app.notifyMetricsUpdate', data);
  }

  /**
   * Daemon 推送项目更新（转发给 AppGateway）
   */
  @SubscribeMessage('daemon:projectUpdate')
  handleProjectUpdate(
    @MessageBody() data: { projectPath: string; metadata?: any },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Received project update for ${data.projectPath} from daemon ${client.id}`);

    // 通过事件转发给 AppGateway，广播给所有 Swift 客户端
    this.eventEmitter.emit('app.notifyProjectUpdate', data);
  }

  /**
   * Daemon 推送会话更新（转发给 AppGateway）
   */
  @SubscribeMessage('daemon:sessionUpdate')
  handleSessionUpdate(
    @MessageBody() data: { sessionId: string; metadata: any },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Received session update for ${data.sessionId} from daemon ${client.id}`);

    // 通过事件转发给 AppGateway，广播给所有 Swift 客户端
    this.eventEmitter.emit('app.notifySessionUpdate', data);
  }

  /**
   * 通知 Daemon 开始监听指定会话文件
   */
  async requestStartWatching(sessionId: string, projectPath: string) {
    const daemons = Array.from(this.connectedDaemons.values());

    if (daemons.length === 0) {
      this.logger.warn(`⚠️ [请求监听] 没有 Daemon 连接，无法启动监听: ${sessionId}`);
      return;
    }

    // 发送给第一个连接的 daemon（后续可以优化为根据项目路径选择特定 daemon）
    const daemon = daemons[0];

    this.logger.log(`🔔 [请求监听] 通知 Daemon 开始监听: ${sessionId}`);
    this.logger.log(`   项目路径: ${projectPath}`);

    // V2: 只传递 projectPath，Daemon 内部查表
    daemon.socket.emit('server:startWatching', {
      sessionId,
      projectPath,
    });
  }

  /**
   * 通知 Daemon 停止监听指定会话文件
   */
  requestStopWatching(sessionId: string, projectPath: string) {
    const daemons = Array.from(this.connectedDaemons.values());

    if (daemons.length === 0) {
      this.logger.warn(`⚠️ [停止监听] 没有 Daemon 连接: ${sessionId}`);
      return;
    }

    const daemon = daemons[0];

    this.logger.log(`🔕 [请求停止] 通知 Daemon 停止监听: ${sessionId}`);

    daemon.socket.emit('server:stopWatching', {
      sessionId,
      projectPath,
    });
  }

  /**
   * 监听来自 AppGateway 的开始监听事件
   */
  @OnEvent('daemon.startWatching')
  handleStartWatchingEvent(data: { sessionId: string; projectPath: string }) {
    this.logger.log(`📥 [事件监听] 收到开始监听事件: ${data.sessionId}`);
    this.requestStartWatching(data.sessionId, data.projectPath);
  }

  /**
   * 监听来自 AppGateway 的停止监听事件
   */
  @OnEvent('daemon.stopWatching')
  handleStopWatchingEvent(data: { sessionId: string; projectPath: string }) {
    this.logger.log(`📥 [事件监听] 收到停止监听事件: ${data.sessionId}`);
    this.requestStopWatching(data.sessionId, data.projectPath);
  }

  /**
   * 监听 CLI 切回 Local 模式事件
   */
  @OnEvent('daemon.resumeLocal')
  handleResumeLocalEvent(data: { sessionId: string }) {
    this.logger.log(`📥 [事件监听] 收到恢复 Local 模式事件: ${data.sessionId}`);

    const daemons = Array.from(this.connectedDaemons.values());
    if (daemons.length === 0) {
      this.logger.warn(`⚠️ [Resume Local] 没有 Daemon 连接`);
      return;
    }

    const daemon = daemons[0];
    daemon.socket.emit('server:resumeLocal', data);
  }

  /**
   * 监听来自 AppGateway 的查找新 session 事件
   */
  @OnEvent('daemon.findNewSession')
  handleFindNewSessionEvent(data: { clientId: string; projectPath: string }) {
    this.logger.log(`📥 [事件监听] 收到查找新Session事件`);
    this.logger.log(`   CLI ID: ${data.clientId}`);
    this.logger.log(`   项目路径: ${data.projectPath}`);

    const daemons = Array.from(this.connectedDaemons.values());
    if (daemons.length === 0) {
      this.logger.warn(`⚠️ [查找新Session] 没有 Daemon 连接`);
      return;
    }

    const daemon = daemons[0];
    daemon.socket.emit('server:findNewSession', {
      clientId: data.clientId,
      projectPath: data.projectPath,
    });

    this.logger.log(`✅ [查找新Session] 已通知 Daemon 开始查找`);
  }

  /**
   * 监听来自 AppGateway 的监听新 session 事件
   */
  @OnEvent('daemon.watchNewSession')
  handleWatchNewSessionEvent(data: { clientId: string; projectPath: string }) {
    this.logger.log(`📥 [事件监听] 收到监听新Session事件`);
    this.logger.log(`   CLI ID: ${data.clientId}`);
    this.logger.log(`   项目路径: ${data.projectPath}`);

    const daemons = Array.from(this.connectedDaemons.values());
    if (daemons.length === 0) {
      this.logger.warn(`⚠️ [监听新Session] 没有 Daemon 连接`);
      return;
    }

    const daemon = daemons[0];
    daemon.socket.emit('server:watchNewSession', {
      clientId: data.clientId,
      projectPath: data.projectPath,
    });

    this.logger.log(`✅ [监听新Session] 已通知 Daemon 开始监听`);
  }

  /**
   * 监听来自 AppGateway 的会话发现事件
   */
  @OnEvent('daemon.sessionDiscovered')
  handleSessionDiscoveredEvent(data: { projectPath: string; sessionId: string }) {
    const daemons = Array.from(this.connectedDaemons.values());

    if (daemons.length === 0) {
      this.logger.warn(`⚠️ [会话发现] 没有 Daemon 连接，无法通知`);
      return;
    }

    const daemon = daemons[0];

    this.logger.log(`📥 [事件监听] 收到会话发现事件: ${data.sessionId}`);
    this.logger.log(`   项目路径: ${data.projectPath}`);

    // 通知 Daemon 刷新项目路径映射
    daemon.socket.emit('server:sessionDiscovered', data);
  }

  /**
   * 接收 Daemon 推送的新 session 查找结果
   */
  @SubscribeMessage('daemon:newSessionFound')
  handleNewSessionFound(
    @MessageBody() data: { clientId: string; sessionId: string; projectPath: string; encodedDirName: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`✅ [Daemon通知] 找到新Session`);
    this.logger.log(`   ClientId: ${data.clientId}`);
    this.logger.log(`   SessionId: ${data.sessionId}`);
    this.logger.log(`   ProjectPath: ${data.projectPath}`);

    // 通过事件转发给 AppGateway，让它通知 CLI
    this.eventEmitter.emit('app.notifyNewSessionFound', data);

    return { success: true };
  }

  /**
   * 接收 Daemon 推送的未找到 session 通知
   */
  @SubscribeMessage('daemon:newSessionNotFound')
  handleNewSessionNotFound(
    @MessageBody() data: { clientId: string; projectPath: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`❌ [Daemon通知] 未找到新Session`);
    this.logger.log(`   ClientId: ${data.clientId}`);
    this.logger.log(`   ProjectPath: ${data.projectPath}`);

    // 通过事件转发给 AppGateway，让它通知 CLI
    this.eventEmitter.emit('app.notifyNewSessionNotFound', data);

    return { success: true };
  }

  /**
   * 接收 Daemon 推送的监听器启动通知
   */
  @SubscribeMessage('daemon:watchStarted')
  handleWatchStarted(
    @MessageBody() data: { clientId: string; projectPath: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`👀 [Daemon通知] 监听器已启动`);
    this.logger.log(`   ClientId: ${data.clientId}`);
    this.logger.log(`   ProjectPath: ${data.projectPath}`);

    // 通过事件转发给 AppGateway，让它通知 CLI
    this.eventEmitter.emit('app.notifyWatchStarted', data);

    return { success: true };
  }

  /**
   * 接收 Daemon 推送的新 session 创建通知
   */
  @SubscribeMessage('daemon:newSessionCreated')
  handleNewSessionCreated(
    @MessageBody() data: { clientId: string; sessionId: string; projectPath: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🆕 [Daemon通知] 新Session已创建`);
    this.logger.log(`   ClientId: ${data.clientId}`);
    this.logger.log(`   SessionId: ${data.sessionId}`);
    this.logger.log(`   ProjectPath: ${data.projectPath}`);

    // 通过事件转发给 AppGateway，让它通知 CLI
    this.eventEmitter.emit('app.notifyNewSessionCreated', data);

    return { success: true };
  }

  /**
   * 接收 Daemon 的权限请求（转发给 AppGateway）
   */
  @SubscribeMessage('daemon:approvalRequest')
  handleApprovalRequest(
    @MessageBody() data: {
      requestId: string;
      sessionId: string;
      clientId: string;
      toolName: string;
      input: any;
      toolUseID: string;
      description: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🔐 [权限请求] 收到 Daemon 的权限请求`);
    this.logger.log(`   RequestId: ${data.requestId}`);
    this.logger.log(`   Tool: ${data.toolName}`);
    this.logger.log(`   ClientId: ${data.clientId}`);

    // 通过事件转发给 AppGateway，让它推送给 iOS 客户端
    this.eventEmitter.emit('app.sendApprovalRequest', data);
  }

  /**
   * 监听来自 AppGateway 的权限响应事件
   */
  @OnEvent('daemon.sendApprovalResponse')
  handleSendApprovalResponse(data: { requestId: string; approved: boolean; reason?: string }) {
    this.logger.log(`✅ [权限响应] 转发给 Daemon`);
    this.logger.log(`   RequestId: ${data.requestId}`);
    this.logger.log(`   Approved: ${data.approved}`);

    const daemons = Array.from(this.connectedDaemons.values());
    if (daemons.length === 0) {
      this.logger.warn(`⚠️ [权限响应] 没有 Daemon 连接`);
      return;
    }

    const daemon = daemons[0];
    daemon.socket.emit('server:approvalResponse', data);
  }

  /**
   * 接收 Daemon 的权限超时通知（转发给 AppGateway）
   */
  @SubscribeMessage('daemon:approvalTimeout')
  handleApprovalTimeout(
    @MessageBody() data: {
      requestId: string;
      sessionId: string;
      clientId: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`⏰ [权限超时] 收到 Daemon 的超时通知`);
    this.logger.log(`   RequestId: ${data.requestId}`);
    this.logger.log(`   ClientId: ${data.clientId}`);

    // 通过事件转发给 AppGateway，让它通知 iOS 客户端
    this.eventEmitter.emit('app.sendApprovalTimeout', data);
  }

  /**
   * 接收 Daemon 的延迟响应通知（转发给 AppGateway）
   */
  @SubscribeMessage('daemon:approvalExpired')
  handleApprovalExpired(
    @MessageBody() data: {
      requestId: string;
      message: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`⚠️ [延迟响应] 收到 Daemon 的过期通知`);
    this.logger.log(`   RequestId: ${data.requestId}`);
    this.logger.log(`   Message: ${data.message}`);

    // 通过事件转发给 AppGateway，让它通知 iOS 客户端
    this.eventEmitter.emit('app.sendApprovalExpired', data);
  }

  /**
   * 接收 Daemon 的 SDK 错误通知（转发给 AppGateway）
   */
  @SubscribeMessage('daemon:sdkError')
  handleSDKError(
    @MessageBody() data: {
      sessionId: string;
      clientId: string;
      error: { type: string; message: string };
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`❌ [SDK 错误] 收到 Daemon 的错误通知`);
    this.logger.log(`   SessionId: ${data.sessionId}`);
    this.logger.log(`   ClientId: ${data.clientId}`);
    this.logger.log(`   Error: ${data.error.message}`);

    // 通过事件转发给 AppGateway，让它通知 iOS 客户端
    this.eventEmitter.emit('app.sendSDKError', data);
  }

  /**
   * 接收 Daemon 的 Swift 活动通知
   * 检查该 session 的 CLI 是否在 local mode，如果是则重新触发 remote-connect
   */
  @SubscribeMessage('daemon:swiftActivity')
  handleSwiftActivity(
    @MessageBody() data: { sessionId: string; projectPath: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`📱 [Swift 活动] Session: ${data.sessionId}`);

    // 通过事件转发给 AppGateway，让它检查是否需要重新进入 remote mode
    this.eventEmitter.emit('app.checkRemoteMode', data);
  }

  // =================== ETerm 相关事件处理 ===================

  /**
   * 接收 Daemon 通知：ETerm 已上线
   */
  @SubscribeMessage('daemon:etermOnline')
  handleEtermOnline(
    @MessageBody() data: { timestamp: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🖥️ [ETerm] 上线通知 at ${data.timestamp}`);
    this.etermOnline = true;

    // 通过事件通知 AppGateway，让它广播给 Mobile 客户端
    this.eventEmitter.emit('app.etermStatusChanged', {
      online: true,
      timestamp: data.timestamp,
    });

    return { success: true };
  }

  /**
   * 接收 Daemon 通知：ETerm 已离线
   */
  @SubscribeMessage('daemon:etermOffline')
  handleEtermOffline(
    @MessageBody() data: { timestamp: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🖥️ [ETerm] 离线通知 at ${data.timestamp}`);
    this.etermOnline = false;
    this.etermSessions.clear();

    // 通过事件通知 AppGateway
    this.eventEmitter.emit('app.etermStatusChanged', {
      online: false,
      timestamp: data.timestamp,
    });

    return { success: true };
  }

  /**
   * 接收 Daemon 通知：某个 session 在 ETerm 中可用
   */
  @SubscribeMessage('daemon:etermSessionAvailable')
  handleEtermSessionAvailable(
    @MessageBody() data: { sessionId: string; timestamp: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🖥️ [ETerm] Session 可用: ${data.sessionId}`);
    this.etermSessions.add(data.sessionId);

    // 通过事件通知 AppGateway
    this.eventEmitter.emit('app.etermSessionAvailable', {
      sessionId: data.sessionId,
      timestamp: data.timestamp,
    });

    return { success: true };
  }

  /**
   * 接收 Daemon 通知：某个 session 不再在 ETerm 中可用
   */
  @SubscribeMessage('daemon:etermSessionUnavailable')
  handleEtermSessionUnavailable(
    @MessageBody() data: { sessionId: string; timestamp: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🖥️ [ETerm] Session 不可用: ${data.sessionId}`);
    this.etermSessions.delete(data.sessionId);

    // 通过事件通知 AppGateway
    this.eventEmitter.emit('app.etermSessionUnavailable', {
      sessionId: data.sessionId,
      timestamp: data.timestamp,
    });

    return { success: true };
  }

  // =================== ETerm 状态查询方法 ===================

  /**
   * 检查 ETerm 是否在线
   */
  isEtermOnline(): boolean {
    return this.etermOnline;
  }

  /**
   * 检查指定 session 是否在 ETerm 中可用
   */
  isSessionInEterm(sessionId: string): boolean {
    return this.etermSessions.has(sessionId);
  }

  /**
   * 获取所有在 ETerm 中的 session
   */
  getEtermSessions(): string[] {
    return Array.from(this.etermSessions);
  }

  /**
   * 向 ETerm 注入消息（通过 Daemon 转发）
   */
  injectMessageToEterm(sessionId: string, text: string): boolean {
    if (!this.etermOnline) {
      this.logger.warn('❌ ETerm 未在线，无法注入消息');
      return false;
    }

    if (!this.etermSessions.has(sessionId)) {
      this.logger.warn(`❌ Session ${sessionId} 不在 ETerm 中`);
      return false;
    }

    const daemons = Array.from(this.connectedDaemons.values());
    if (daemons.length === 0) {
      this.logger.warn('❌ 没有 Daemon 连接，无法注入消息');
      return false;
    }

    const daemon = daemons[0];
    daemon.socket.emit('server:injectToEterm', {
      sessionId,
      text,
    });

    this.logger.log(`💉 [ETerm] 发送注入请求: session=${sessionId}`);
    return true;
  }

  /**
   * 通知 ETerm：Mobile 正在查看某个 session
   */
  notifyEtermMobileViewing(sessionId: string, isViewing: boolean) {
    if (!this.etermOnline) {
      return;
    }

    const daemons = Array.from(this.connectedDaemons.values());
    if (daemons.length === 0) {
      return;
    }

    const daemon = daemons[0];
    daemon.socket.emit('server:mobileViewing', {
      sessionId,
      isViewing,
    });

    this.logger.log(`📱 [ETerm] Mobile ${isViewing ? '正在查看' : '离开了'} session ${sessionId}`);
  }

  /**
   * 模块销毁时的清理逻辑 - 解决热重启端口占用问题
   */
  async onModuleDestroy() {
    this.logger.log('🧹 [清理] 开始 Daemon Gateway WebSocket 清理...');

    try {
      if (!this.server) {
        this.logger.warn('⚠️ Socket.IO Server 未初始化，跳过清理');
        return;
      }

      // 1. 通知所有 Daemon 客户端服务器即将关闭
      this.server.emit('server-shutdown', {
        message: 'Server is shutting down',
        timestamp: Date.now(),
      });

      // 2. 等待 100ms 让消息发送出去
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 3. 断开所有 Daemon 连接
      const sockets = await this.server.fetchSockets();
      for (const socket of sockets) {
        socket.disconnect(true);
      }
      this.logger.log(`🔌 已断开 ${sockets.length} 个 Daemon 连接`);

      // 4. 清理 Daemon 记录
      this.connectedDaemons.clear();

      // 5. 关闭 Socket.IO Server (Daemon namespace)
      await new Promise<void>((resolve, reject) => {
        this.server.close((err) => {
          if (err) {
            this.logger.error('❌ 关闭 Daemon Gateway Socket.IO Server 失败:', err);
            reject(err);
          } else {
            this.logger.log('✅ Daemon Gateway Socket.IO Server 已关闭');
            resolve();
          }
        });
      });

    } catch (error) {
      this.logger.error('❌ Daemon Gateway WebSocket 清理过程中出错:', error);
      throw error;
    }
  }
}
