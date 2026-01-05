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
import { Logger, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { ProjectService } from '../project/project.service';
import { SessionService } from '../session/session.service';
import { RegistryService } from '../registry/registry.service';


/**
 * Daemon Gateway
 * 接收来自 daemon 的 WebSocket 连接
 */
@WebSocketGateway({
  namespace: '/daemon',
  cors: {
    origin: '*',
  },
  transports: ['polling', 'websocket'],
})
export class DaemonGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(DaemonGateway.name);
  private connectedDaemons = new Map<string, { socket: Socket; info: any }>();

  // ETerm 状态已迁移到 Redis，通过 RegistryService 读取
  // 详见 PLAN_REDIS_STATE_SYNC.md

  constructor(
    private readonly projectService: ProjectService,
    private readonly sessionService: SessionService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => RegistryService))
    private readonly registryService: RegistryService,
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
   * 接收 daemon 发送的项目数据（已废弃，数据源改为 SharedDb）
   */
  @SubscribeMessage('daemon:projectData')
  async handleProjectData(
    @MessageBody() data: { projects: any[] },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`[废弃] Received ${data.projects.length} projects from daemon ${client.id}, 数据源已改为 SharedDb`);
    return { success: true, deprecated: true };
  }

  /**
   * 接收 daemon 发送的会话元数据（已废弃，数据源改为 SharedDb）
   */
  @SubscribeMessage('daemon:sessionMetadata')
  async handleSessionMetadata(
    @MessageBody() data: { projectPath: string; sessions: any[] },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`[废弃] Received session metadata from daemon ${client.id}, 数据源已改为 SharedDb`);
    return { success: true, deprecated: true };
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
   * Daemon 推送会话列表更新（转发给 AppGateway）
   */
  @SubscribeMessage('daemon:sessionListUpdate')
  handleSessionListUpdate(
    @MessageBody() data: { projectPath: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Received session list update for ${data.projectPath} from daemon ${client.id}`);

    // 通过事件转发给 AppGateway，广播给所有 iOS 客户端
    this.eventEmitter.emit('app.notifySessionListUpdate', data);
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
   * 注意：ETerm 状态由 Redis 维护，此处只转发事件
   */
  @SubscribeMessage('daemon:etermOnline')
  handleEtermOnline(
    @MessageBody() data: { timestamp: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🖥️ [ETerm] 上线通知 at ${data.timestamp}`);
    // 状态由 VlaudeKit 直接写入 Redis，此处只转发事件给 Mobile 客户端

    // 通过事件通知 AppGateway，让它广播给 Mobile 客户端
    this.eventEmitter.emit('app.etermStatusChanged', {
      online: true,
      timestamp: data.timestamp,
    });

    return { success: true };
  }

  /**
   * 接收 Daemon 通知：ETerm 已离线
   * 注意：ETerm 状态由 Redis 维护（TTL 过期），此处只转发事件
   */
  @SubscribeMessage('daemon:etermOffline')
  handleEtermOffline(
    @MessageBody() data: { timestamp: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🖥️ [ETerm] 离线通知 at ${data.timestamp}`);
    // 状态由 VlaudeKit 从 Redis 注销，此处只转发事件给 Mobile 客户端

    // 通过事件通知 AppGateway
    this.eventEmitter.emit('app.etermStatusChanged', {
      online: false,
      timestamp: data.timestamp,
    });

    return { success: true };
  }

  /**
   * 接收 Daemon 通知：某个 session 在 ETerm 中可用
   * 注意：Session 状态由 VlaudeKit 直接写入 Redis，此处只转发事件
   */
  @SubscribeMessage('daemon:etermSessionAvailable')
  handleEtermSessionAvailable(
    @MessageBody() data: { sessionId: string; projectPath: string; timestamp: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🖥️ [ETerm] Session 可用: ${data.sessionId}`);
    this.logger.log(`   ProjectPath: ${data.projectPath}`);
    // Session 状态由 VlaudeKit 直接写入 Redis

    // 通过事件通知 AppGateway（包含 projectPath）
    this.eventEmitter.emit('app.etermSessionAvailable', {
      sessionId: data.sessionId,
      projectPath: data.projectPath,
      timestamp: data.timestamp,
    });

    return { success: true };
  }

  /**
   * 接收 Daemon 通知：某个 session 不再在 ETerm 中可用
   * 注意：Session 状态由 VlaudeKit 直接从 Redis 移除，此处只转发事件
   */
  @SubscribeMessage('daemon:etermSessionUnavailable')
  handleEtermSessionUnavailable(
    @MessageBody() data: { sessionId: string; projectPath?: string; timestamp: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🖥️ [ETerm] Session 不可用: ${data.sessionId}`);
    // Session 状态由 VlaudeKit 直接从 Redis 移除

    // 通过事件通知 AppGateway（projectPath 从 Daemon 传入）
    this.eventEmitter.emit('app.etermSessionUnavailable', {
      sessionId: data.sessionId,
      projectPath: data.projectPath,
      timestamp: data.timestamp,
    });

    return { success: true };
  }

  /**
   * 接收 Daemon 通知：ETerm 会话创建完成（带 requestId）
   * 注意：Session 状态由 VlaudeKit 直接写入 Redis，此处只转发事件
   */
  @SubscribeMessage('daemon:etermSessionCreated')
  handleEtermSessionCreated(
    @MessageBody() data: { requestId: string; sessionId: string; projectPath: string; timestamp: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🖥️ [ETerm] 会话创建完成:`);
    this.logger.log(`   RequestId: ${data.requestId}`);
    this.logger.log(`   SessionId: ${data.sessionId}`);
    this.logger.log(`   ProjectPath: ${data.projectPath}`);
    // Session 状态由 VlaudeKit 直接写入 Redis

    // 通过事件通知 AppGateway，让它推送给 iOS 客户端
    this.eventEmitter.emit('app.etermSessionCreated', {
      requestId: data.requestId,
      sessionId: data.sessionId,
      projectPath: data.projectPath,
      timestamp: data.timestamp,
    });

    return { success: true };
  }

  // =================== ETerm 状态查询方法（从 Redis 读取）===================

  /**
   * 检查 ETerm 是否在线（从 Redis 读取）
   * ETerm 设备 ID 固定为 "eterm"
   */
  async isEtermOnline(): Promise<boolean> {
    const daemons = await this.registryService.getDaemons();
    // ETerm 的 deviceId 固定为 "eterm"（或以 "eterm" 开头）
    return daemons.some(d => d.deviceId === 'eterm' || d.deviceId.startsWith('eterm-'));
  }

  /**
   * 检查指定 session 是否在 ETerm 中可用（从 Redis 读取）
   */
  async isSessionInEterm(sessionId: string): Promise<boolean> {
    const daemons = await this.registryService.getDaemons();
    // 查找 ETerm daemon 的 sessions
    for (const daemon of daemons) {
      if (daemon.deviceId === 'eterm' || daemon.deviceId.startsWith('eterm-')) {
        if (daemon.sessions.some(s => s.sessionId === sessionId)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 获取所有在 ETerm 中的 session（返回 sessionId 数组，从 Redis 读取）
   */
  async getEtermSessions(): Promise<string[]> {
    const daemons = await this.registryService.getDaemons();
    const sessions: string[] = [];
    for (const daemon of daemons) {
      if (daemon.deviceId === 'eterm' || daemon.deviceId.startsWith('eterm-')) {
        sessions.push(...daemon.sessions.map(s => s.sessionId));
      }
    }
    return sessions;
  }

  /**
   * 获取每个项目的在线会话数（用于 iOS 项目列表显示，从 Redis 读取）
   * @returns { [projectPath: string]: number }
   */
  async getEtermSessionCounts(): Promise<Record<string, number>> {
    const daemons = await this.registryService.getDaemons();
    const counts: Record<string, number> = {};
    for (const daemon of daemons) {
      if (daemon.deviceId === 'eterm' || daemon.deviceId.startsWith('eterm-')) {
        for (const session of daemon.sessions) {
          counts[session.projectPath] = (counts[session.projectPath] || 0) + 1;
        }
      }
    }
    return counts;
  }

  /**
   * 向 ETerm 注入消息（通过广播给所有 Daemon）
   * 注意：现在从 Redis 读取状态，已改为 async
   *
   * 改进：广播给所有连接的 daemon，让拥有 sessionId 的 daemon 处理
   * 这样可以确保消息到达 VlaudeKit（Swift 插件），而不是只发给第一个 daemon
   *
   * @param sessionId 会话ID
   * @param text 消息内容
   * @param clientMessageId 客户端生成的消息ID，用于乐观更新去重
   */
  async injectMessageToEterm(sessionId: string, text: string, clientMessageId?: string): Promise<boolean> {
    const online = await this.isEtermOnline();
    if (!online) {
      this.logger.warn('❌ ETerm 未在线，无法注入消息');
      return false;
    }

    const inEterm = await this.isSessionInEterm(sessionId);
    if (!inEterm) {
      this.logger.warn(`❌ Session ${sessionId} 不在 ETerm 中`);
      return false;
    }

    // 广播给所有连接的 daemon，让拥有 sessionId 的 daemon 处理
    // VlaudeKit 和 vlaude-daemon-rs 都连接到 /daemon namespace
    // 只有实际拥有该 sessionId 的 daemon 会处理这个事件
    this.server.emit('server:injectToEterm', {
      sessionId,
      text,
      clientMessageId,  // 透传 clientMessageId，用于消息去重
    });

    this.logger.log(`💉 [ETerm] 广播注入请求: session=${sessionId}, text.length=${text.length}, clientMsgId=${clientMessageId || 'N/A'}`);
    return true;
  }

  /**
   * 请求 ETerm 创建新的 Claude 会话（通过广播给所有 Daemon）
   * 注意：现在从 Redis 读取状态，已改为 async
   * @param projectPath 项目路径
   * @param prompt 可选的初始提示词
   * @param requestId 可选的请求ID，用于跟踪会话创建
   * @returns 是否成功发送请求
   */
  async requestEtermCreateSession(projectPath: string, prompt?: string, requestId?: string): Promise<boolean> {
    const online = await this.isEtermOnline();
    if (!online) {
      this.logger.warn('❌ ETerm 未在线，无法创建会话');
      return false;
    }

    // 广播给所有 daemon，VlaudeKit 会处理
    this.server.emit('server:createSessionInEterm', {
      projectPath,
      prompt,
      requestId,  // 透传 requestId
    });

    this.logger.log(`🖥️ [ETerm] 广播创建会话请求: projectPath=${projectPath}, requestId=${requestId || 'N/A'}`);
    return true;
  }

  /**
   * 通知 ETerm：Mobile 正在查看某个 session（通过广播给所有 Daemon）
   * 注意：现在从 Redis 读取状态，已改为 async
   */
  async notifyEtermMobileViewing(sessionId: string, isViewing: boolean): Promise<void> {
    const online = await this.isEtermOnline();
    if (!online) {
      return;
    }

    // 广播给所有 daemon，VlaudeKit 会处理
    this.server.emit('server:mobileViewing', {
      sessionId,
      isViewing,
    });

    this.logger.log(`📱 [ETerm] 广播 Mobile ${isViewing ? '正在查看' : '离开了'} session ${sessionId}`);
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
