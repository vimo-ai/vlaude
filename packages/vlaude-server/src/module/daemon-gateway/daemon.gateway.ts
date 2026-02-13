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
import { RegistryService } from '../registry/registry.service';
import { StatusService } from '../status';
import { DataSyncService, DaemonMessage } from '../data-sync';
import { StatusDaemonInfo, StatusSessionInfo } from '@vimo-ai/vlaude-shared-core';
import { DaemonEvents, ServerEvents } from '../../shared/events';
import { ToolUseCorrelator } from './tool-use-correlator';
import { ApprovalStateStore } from './approval-state.store';


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

  // V4: 请求-响应模式的 pending requests
  // Key: requestId, Value: { resolve, timer, startTime }
  private pendingProjectRequests = new Map<string, { resolve: Function; timer: NodeJS.Timeout; startTime: number }>();
  private pendingSessionRequests = new Map<string, { resolve: Function; timer: NodeJS.Timeout; startTime: number }>();
  private pendingMessageRequests = new Map<string, { resolve: Function; timer: NodeJS.Timeout; startTime: number }>();

  // iOS 创建会话请求的 pending Map（requestId → projectPath，用于 result 回调时补充 projectPath）
  private pendingCreateRequests = new Map<string, { projectPath: string; createdAt: number }>();

  // 分段传输缓冲区
  // Key: transferId, Value: { event, chunks, total, receivedCount, timer }
  private chunkBuffers = new Map<string, {
    event: string;
    chunks: string[];
    total: number;
    receivedCount: number;
    timer: NodeJS.Timeout;
  }>();

  // PreToolUse ↔ PermissionRequest 关联器
  private readonly toolUseCorrelator = new ToolUseCorrelator();

  // 审批状态存储（支持 iOS 查询 pending approvals）
  private readonly approvalStateStore = new ApprovalStateStore();

  // ETerm 状态已迁移到 Redis，通过 RegistryService 读取
  // 详见 PLAN_REDIS_STATE_SYNC.md

  /** 统一 DIAG 日志 */
  private diagLog(tag: string, event: string, sessionId: string, tool?: string, toolUseId?: string) {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const parts = [`[DIAG] ${tag} ts=${ts} event=${event} sid=${sessionId.substring(0, 8)}`];
    if (tool) parts.push(`tool=${tool}`);
    if (toolUseId?.trim()) parts.push(`toolUseId=${toolUseId.substring(0, 12)}`);
    this.logger.log(parts.join(' '));
  }

  constructor(
    private readonly eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => RegistryService))
    private readonly registryService: RegistryService,
    private readonly statusService: StatusService,
    private readonly dataSyncService: DataSyncService,
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
   * 接收 Daemon 发送的分段数据
   * 大 payload 超过 512KB 时，Daemon 会自动分段发送
   * 凑齐所有 chunk 后拼装 JSON，分派到原事件 handler
   */
  @SubscribeMessage(DaemonEvents.CHUNK)
  handleChunk(
    @MessageBody() data: { transferId: string; event: string; seq: number; total: number; data: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { transferId, event, seq, total } = data;

    if (!this.chunkBuffers.has(transferId)) {
      // 首个 chunk，初始化缓冲区 + 30s TTL
      const timer = setTimeout(() => {
        this.logger.warn(`⏰ [Chunk] 传输超时，丢弃: transferId=${transferId}, event=${event}, received=${this.chunkBuffers.get(transferId)?.receivedCount}/${total}`);
        this.chunkBuffers.delete(transferId);
      }, 30000);

      this.chunkBuffers.set(transferId, {
        event,
        chunks: new Array(total).fill(''),
        total,
        receivedCount: 0,
        timer,
      });
    }

    const buffer = this.chunkBuffers.get(transferId)!;
    buffer.chunks[seq] = data.data;
    buffer.receivedCount++;

    this.logger.log(`📦 [Chunk] transferId=${transferId}, seq=${seq}/${total}, event=${event}`);

    // 凑齐所有 chunk
    if (buffer.receivedCount >= buffer.total) {
      clearTimeout(buffer.timer);
      this.chunkBuffers.delete(transferId);

      // 拼装 JSON
      const fullJson = buffer.chunks.join('');
      this.logger.log(`✅ [Chunk] 组装完成: transferId=${transferId}, event=${event}, size=${fullJson.length}`);

      try {
        const payload = JSON.parse(fullJson);
        // 分派到原事件 handler
        this.dispatchReassembledEvent(event, payload, client);
      } catch (err) {
        this.logger.error(`❌ [Chunk] JSON 解析失败: transferId=${transferId}, error=${err}`);
      }
    }

    return { success: true };
  }

  /**
   * 将组装后的 chunk 数据分派到对应的事件 handler
   */
  private dispatchReassembledEvent(event: string, payload: any, client: Socket) {
    switch (event) {
      case DaemonEvents.SESSION_MESSAGES:
        this.handleSessionMessages(payload, client);
        break;
      case DaemonEvents.PROJECT_DATA:
        this.handleProjectData(payload, client);
        break;
      case DaemonEvents.SESSION_METADATA:
        this.handleSessionMetadata(payload, client);
        break;
      default:
        this.logger.warn(`⚠️ [Chunk] 未知事件类型: ${event}`);
    }
  }

  /**
   * Daemon 注册
   */
  @SubscribeMessage(DaemonEvents.REGISTER)
  async handleDaemonRegister(
    @MessageBody() data: { hostname: string; platform: string; version: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`Daemon registered: ${data.hostname} (${data.platform})`);

    this.connectedDaemons.set(client.id, {
      socket: client,
      info: data,
    });

    return { event: DaemonEvents.REGISTERED, data: { success: true } };
  }

  /**
   * V4: 接收 daemon 发送的项目数据（请求-响应模式）
   * 根据 requestId 找到对应的 pending Promise 并 resolve
   */
  @SubscribeMessage(DaemonEvents.PROJECT_DATA)
  async handleProjectData(
    @MessageBody() data: { projects: any[]; requestId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const requestId = data.requestId;
    const receiveTime = Date.now();
    this.logger.log(`📥 Received ${data.projects.length} projects from daemon ${client.id}, requestId=${requestId || 'N/A'}`);

    if (requestId && this.pendingProjectRequests.has(requestId)) {
      const { resolve, timer, startTime } = this.pendingProjectRequests.get(requestId)!;
      clearTimeout(timer);
      this.pendingProjectRequests.delete(requestId);
      const roundTrip = receiveTime - startTime;
      this.logger.log(`[Perf] project_data received: roundTrip=${roundTrip}ms, count=${data.projects.length}, requestId=${requestId}`);
      resolve(data.projects);
    }

    return { success: true };
  }

  /**
   * V4: 接收 daemon 发送的会话元数据（请求-响应模式）
   * 根据 requestId 找到对应的 pending Promise 并 resolve
   */
  @SubscribeMessage(DaemonEvents.SESSION_METADATA)
  async handleSessionMetadata(
    @MessageBody() data: { projectPath?: string; sessions: any[]; requestId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const requestId = data.requestId;
    const receiveTime = Date.now();
    this.logger.log(`📥 Received ${data.sessions.length} sessions from daemon ${client.id}, requestId=${requestId || 'N/A'}`);

    if (requestId && this.pendingSessionRequests.has(requestId)) {
      const { resolve, timer, startTime } = this.pendingSessionRequests.get(requestId)!;
      clearTimeout(timer);
      this.pendingSessionRequests.delete(requestId);
      const roundTrip = receiveTime - startTime;
      this.logger.log(`[Perf] session_metadata received: roundTrip=${roundTrip}ms, count=${data.sessions.length}, requestId=${requestId}`);
      resolve(data.sessions);
    }

    return { success: true };
  }

  /**
   * V4: 接收 daemon 发送的会话消息（请求-响应模式）
   * 根据 requestId 找到对应的 pending Promise 并 resolve
   */
  @SubscribeMessage(DaemonEvents.SESSION_MESSAGES)
  async handleSessionMessages(
    @MessageBody() data: {
      sessionId: string;
      projectPath: string;
      messages: any[];
      total: number;
      hasMore: boolean;
      requestId?: string;
      openTurn?: boolean;
      nextCursor?: number;
    },
    @ConnectedSocket() client: Socket,
  ) {
    const requestId = data.requestId;
    const receiveTime = Date.now();
    this.logger.log(`📥 Received ${data.messages.length} messages from daemon ${client.id}, requestId=${requestId || 'N/A'}`);

    if (requestId && this.pendingMessageRequests.has(requestId)) {
      const { resolve, timer, startTime } = this.pendingMessageRequests.get(requestId)!;
      clearTimeout(timer);
      this.pendingMessageRequests.delete(requestId);
      const roundTrip = receiveTime - startTime;
      this.logger.log(`[Perf] session_messages received: roundTrip=${roundTrip}ms, count=${data.messages.length}, requestId=${requestId}`);
      resolve({
        messages: data.messages,
        total: data.total,
        hasMore: data.hasMore,
        openTurn: data.openTurn,
        nextCursor: data.nextCursor,
      });
    }

    return { success: true };
  }

  /**
   * 向指定 daemon 发送指令
   */
  sendCommandToDaemon(daemonId: string, command: string, data: any) {
    const daemon = this.connectedDaemons.get(daemonId);
    if (daemon) {
      daemon.socket.emit(ServerEvents.COMMAND, { command, data });
      this.logger.log(`Sent command ${command} to daemon ${daemonId}`);
    }
  }

  /**
   * 广播指令到所有 daemon
   */
  broadcastCommand(command: string, data: any) {
    this.server.emit(ServerEvents.COMMAND, { command, data });
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

  // =================== V4: 代理请求方法（请求-响应事件模式） ===================

  /**
   * 生成唯一的 requestId
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * V4: 请求 daemon 获取项目列表（使用 server:requestProjectData 事件）
   * Rust Daemon 会响应 daemon:projectData 事件
   */
  async requestProjects(limit: number = 50, offset: number = 0): Promise<{
    projects: any[];
    total: number;
    hasMore: boolean;
  } | null> {
    const totalStart = Date.now();
    const daemons = Array.from(this.connectedDaemons.values());
    if (daemons.length === 0) {
      this.logger.warn('No daemon connected, cannot request projects');
      return null;
    }

    const daemon = daemons[0];
    const requestId = this.generateRequestId();
    const startTime = Date.now();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingProjectRequests.delete(requestId);
        this.logger.error(`Request projects timeout (requestId=${requestId})`);
        resolve(null);
      }, 10000);

      this.pendingProjectRequests.set(requestId, {
        resolve: (projects: any[]) => {
          // Rust 返回全量，在这里做分页
          const sliceStart = Date.now();
          const sliced = projects.slice(offset, offset + limit);
          const sliceTime = Date.now() - sliceStart;
          const totalTime = Date.now() - totalStart;
          this.logger.log(`[Perf] requestProjects completed: total=${totalTime}ms, slice=${sliceTime}ms, rawCount=${projects.length}, returnCount=${sliced.length}`);
          resolve({
            projects: sliced,
            total: projects.length,
            hasMore: offset + sliced.length < projects.length,
          });
        },
        timer,
        startTime,
      });

      // 发送请求事件（复用 Rust 已有的 server:requestProjectData）
      daemon.socket.emit(ServerEvents.REQUEST_PROJECT_DATA, { limit, requestId });
      this.logger.log(`📤 Sent server:requestProjectData (requestId=${requestId})`);
    });
  }

  /**
   * V4: 请求 daemon 根据路径获取项目
   * 先获取全量项目，然后在本地筛选
   */
  async requestProjectByPath(path: string): Promise<any | null> {
    const result = await this.requestProjects(1000, 0);
    if (!result) return null;

    const project = result.projects.find((p: any) => p.path === path);
    return project || null;
  }

  /**
   * V4: 请求 daemon 获取会话列表（使用 server:requestSessionMetadata 事件）
   * Rust Daemon 会响应 daemon:sessionMetadata 事件
   */
  async requestSessions(projectPath: string, limit: number = 50, offset: number = 0, sessionId?: string): Promise<{
    sessions: any[];
    total: number;
    hasMore: boolean;
  } | null> {
    const totalStart = Date.now();
    const daemons = Array.from(this.connectedDaemons.values());
    if (daemons.length === 0) {
      this.logger.warn('No daemon connected, cannot request sessions');
      return null;
    }

    const daemon = daemons[0];
    const requestId = this.generateRequestId();
    const startTime = Date.now();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSessionRequests.delete(requestId);
        this.logger.error(`Request sessions timeout for ${projectPath} (requestId=${requestId})`);
        resolve(null);
      }, 10000);

      this.pendingSessionRequests.set(requestId, {
        resolve: (sessions: any[]) => {
          // Rust 返回全量，在这里做分页
          const sliceStart = Date.now();
          const sliced = sessions.slice(offset, offset + limit);
          const sliceTime = Date.now() - sliceStart;
          const totalTime = Date.now() - totalStart;
          this.logger.log(`[Perf] requestSessions completed: total=${totalTime}ms, slice=${sliceTime}ms, rawCount=${sessions.length}, returnCount=${sliced.length}, project=${projectPath}`);
          resolve({
            sessions: sliced,
            total: sessions.length,
            hasMore: offset + sliced.length < sessions.length,
          });
        },
        timer,
        startTime,
      });

      // 发送请求事件（复用 Rust 已有的 server:requestSessionMetadata）
      const payload: Record<string, any> = { projectPath, requestId };
      if (sessionId) payload.sessionId = sessionId;
      daemon.socket.emit(ServerEvents.REQUEST_SESSION_METADATA, payload);
      this.logger.log(`📤 Sent server:requestSessionMetadata (projectPath=${projectPath}, sessionId=${sessionId || 'all'}, requestId=${requestId})`);
    });
  }

  /**
   * V4: 请求 daemon 根据 sessionId 获取会话详情
   * 直接传 sessionId 给 daemon，精确查询单个 session
   */
  async requestSessionBySessionId(sessionId: string, projectPath: string): Promise<any | null> {
    const result = await this.requestSessions(projectPath, 1, 0, sessionId);
    if (!result || result.sessions.length === 0) return null;
    return result.sessions[0];
  }

  /**
   * V4: 请求 daemon 读取会话消息（使用 server:requestSessionMessages 事件）
   * Rust Daemon 会响应 daemon:sessionMessages 事件
   * 支持 turnsLimit 模式（按 Turn 分页）和传统 limit/offset 模式
   */
  async requestSessionMessages(
    sessionId: string,
    projectPath: string,
    turnsLimit?: number,
    before?: number,
    limit?: number,
    offset?: number,
    order?: 'asc' | 'desc',
    detail?: 'summary' | 'full',
  ): Promise<{ messages: any[]; total: number; hasMore: boolean; openTurn?: boolean; nextCursor?: number } | null> {
    const totalStart = Date.now();
    const daemons = Array.from(this.connectedDaemons.values());
    if (daemons.length === 0) {
      this.logger.warn('No daemon connected, cannot request session messages');
      return null;
    }

    const daemon = daemons[0];
    const requestId = this.generateRequestId();
    const startTime = Date.now();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingMessageRequests.delete(requestId);
        this.logger.error(`Request session messages timeout for ${sessionId} (requestId=${requestId})`);
        resolve(null);
      }, 10000);

      this.pendingMessageRequests.set(requestId, {
        resolve: (result: { messages: any[]; total: number; hasMore: boolean; openTurn?: boolean; nextCursor?: number }) => {
          const totalTime = Date.now() - totalStart;
          this.logger.log(`[Perf] requestSessionMessages completed: total=${totalTime}ms, count=${result.messages.length}, session=${sessionId}`);
          resolve(result);
        },
        timer,
        startTime,
      });

      // 构建请求 payload，只传有值的字段
      const payload: Record<string, any> = { sessionId, projectPath, requestId };
      if (turnsLimit !== undefined) payload.turnsLimit = turnsLimit;
      if (before !== undefined) payload.before = before;
      if (limit !== undefined) payload.limit = limit;
      if (offset !== undefined) payload.offset = offset;
      if (order !== undefined) payload.order = order;
      if (detail !== undefined) payload.detail = detail;

      daemon.socket.emit(ServerEvents.REQUEST_SESSION_MESSAGES, payload);
      this.logger.log(`📤 Sent server:requestSessionMessages (sessionId=${sessionId}, turnsLimit=${turnsLimit}, requestId=${requestId})`);
    });
  }

  /**
   * Daemon 推送新消息（转发给 AppGateway）
   *
   * V5 (Phase 3):
   * - sync 模式下同时写入 Server DB
   * - 然后转发给 iOS 客户端
   */
  @SubscribeMessage(DaemonEvents.NEW_MESSAGE)
  async handleNewMessage(
    @MessageBody() data: { sessionId: string; projectPath?: string; message: any },
    @ConnectedSocket() client: Socket,
  ) {
    // AppGateway.notifyNewMessage 已有日志，此处不重复

    // sync 模式下写入 DB
    if (this.dataSyncService.isSyncMode() && data.projectPath) {
      try {
        // 确保 Project 和 Session 存在
        const projectId = await this.dataSyncService.ensureProject(data.projectPath);
        const sessionDbId = await this.dataSyncService.ensureSession(data.sessionId, projectId, data.projectPath);

        // 写入消息
        const msg = data.message;
        const daemonMessage: DaemonMessage = {
          uuid: msg.uuid || `${data.sessionId}-${msg.sequence}`,
          role: msg.role,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          metadata: msg.metadata,
          sequence: msg.sequence,
          timestamp: msg.timestamp,
          toolCallId: msg.toolCallId,
          approvalStatus: msg.approvalStatus,
          approvalResolvedAt: msg.approvalResolvedAt,
        };

        await this.dataSyncService.writeMessage(sessionDbId, daemonMessage);
        this.logger.log(`📝 [Sync] 消息已写入 Server DB: ${daemonMessage.uuid}`);
      } catch (error) {
        this.logger.error(`❌ [Sync] 写入消息失败: ${error.message}`);
        // 写入失败不影响转发
      }
    }

    // 通过事件转发给 AppGateway，推送到订阅了该会话的 Swift 客户端
    this.eventEmitter.emit('app.notifyNewMessage', data);
  }

  /**
   * Daemon 推送会话更新（转发给 AppGateway）
   */
  @SubscribeMessage(DaemonEvents.SESSION_UPDATE)
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
  @SubscribeMessage(DaemonEvents.SESSION_LIST_UPDATE)
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
    daemon.socket.emit(ServerEvents.START_WATCHING, {
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

    daemon.socket.emit(ServerEvents.STOP_WATCHING, {
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
    daemon.socket.emit(ServerEvents.RESUME_LOCAL, data);
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
    daemon.socket.emit(ServerEvents.FIND_NEW_SESSION, {
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
    daemon.socket.emit(ServerEvents.WATCH_NEW_SESSION, {
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
    daemon.socket.emit(ServerEvents.SESSION_DISCOVERED, data);
  }

  /**
   * 接收 Daemon 推送的新 session 查找结果
   */
  @SubscribeMessage(DaemonEvents.NEW_SESSION_FOUND)
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
  @SubscribeMessage(DaemonEvents.NEW_SESSION_NOT_FOUND)
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
  @SubscribeMessage(DaemonEvents.WATCH_STARTED)
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
  @SubscribeMessage(DaemonEvents.NEW_SESSION_CREATED)
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
   * 接收 PreToolUse 事件（缓存 toolUseId 供 PermissionRequest 关联）
   */
  @SubscribeMessage(DaemonEvents.PRE_TOOL_USE)
  handlePreToolUse(
    @MessageBody() data: {
      sessionId: string;
      toolName: string;
      toolUseId: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.toolUseCorrelator.onPreToolUse(data.sessionId, data.toolUseId, data.toolName);
    this.diagLog('hook-in', 'PreToolUse', data.sessionId, data.toolName, data.toolUseId);
  }

  /**
   * 接收 Daemon 的权限请求（关联 toolUseId 后转发给 AppGateway）
   */
  @SubscribeMessage(DaemonEvents.PERMISSION_REQUEST)
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
    // 关联 toolUseId（PreToolUse 已缓存，PermissionRequest by design 不含 toolUseId）
    if (!data.toolUseID?.trim()) {
      const resolved = this.toolUseCorrelator.resolveToolUseId(data.sessionId, data.toolName);
      if (resolved) {
        data.toolUseID = resolved;
      }
    }

    // 存储审批状态
    this.approvalStateStore.onApprovalRequest({
      requestId: data.requestId,
      sessionId: data.sessionId,
      toolName: data.toolName,
      toolUseId: data.toolUseID || '',
      input: data.input,
      description: data.description,
    });

    // 通过事件转发给 AppGateway，让它推送给 iOS 客户端
    this.diagLog('hook-in', 'PermissionRequest', data.sessionId, data.toolName, data.toolUseID);
    this.eventEmitter.emit('app.sendApprovalRequest', data);
  }

  /**
   * 监听来自 AppGateway 的权限响应事件
   */
  @OnEvent('daemon.sendApprovalResponse')
  handleSendApprovalResponse(data: { requestId: string; sessionId: string; action: string; toolUseId: string }) {
    this.logger.log(`✅ [权限响应] ${data.action} → session=${data.sessionId.substring(0, 8)} toolUseId=${data.toolUseId?.substring(0, 8) || '?'}`);

    // 更新审批状态
    const status = data.action === 'n' ? 'rejected' as const : 'approved' as const;
    this.approvalStateStore.onApprovalResolved(data.sessionId, { toolUseId: data.toolUseId, requestId: data.requestId }, status);

    const daemons = Array.from(this.connectedDaemons.values());
    if (daemons.length === 0) {
      this.logger.warn(`⚠️ [权限响应] 没有 Daemon 连接`);
      return;
    }

    const daemon = daemons[0];
    daemon.socket.emit(ServerEvents.PERMISSION_RESPONSE, data);
  }

  /**
   * 接收 Daemon 的权限超时通知（转发给 AppGateway）
   */
  @SubscribeMessage(DaemonEvents.PERMISSION_TIMEOUT)
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

    // 更新审批状态
    this.approvalStateStore.onApprovalResolved(data.sessionId, { requestId: data.requestId }, 'timeout');

    // 通过事件转发给 AppGateway，让它通知 iOS 客户端
    this.eventEmitter.emit('app.sendApprovalTimeout', data);
  }

  /**
   * 接收 Daemon 的延迟响应通知（转发给 AppGateway）
   */
  @SubscribeMessage(DaemonEvents.PERMISSION_EXPIRED)
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
   * 接收 ETerm 的审批确认（转发给 AppGateway → iOS）
   */
  @SubscribeMessage(DaemonEvents.APPROVAL_ACK)
  handleApprovalAck(
    @MessageBody() data: {
      toolUseId: string;
      sessionId: string;
      success: boolean;
      message?: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`✅ [审批确认] 收到 ETerm 的 approval-ack`);
    this.logger.log(`   ToolUseId: ${data.toolUseId}`);
    this.logger.log(`   SessionId: ${data.sessionId}`);
    this.logger.log(`   Success: ${data.success}`);

    // 更新审批状态（ack = 已执行）
    this.approvalStateStore.onApprovalResolved(data.sessionId, { toolUseId: data.toolUseId }, 'approved');

    // 通过事件转发给 AppGateway，让它通知 iOS 客户端
    this.eventEmitter.emit('app.sendApprovalAck', data);
  }

  /**
   * 接收 ETerm 的权限取消通知（Interrupt/PromptSubmit/ResponseComplete 导致审批过期）
   */
  @SubscribeMessage(DaemonEvents.PERMISSION_CANCELLED)
  handlePermissionCancelled(
    @MessageBody() data: {
      sessionId: string;
      toolUseIds: string[];
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🚫 [权限取消] session=${data.sessionId.substring(0, 8)} tools=${data.toolUseIds.length}`);

    // 更新审批状态
    const cancelled = this.approvalStateStore.cancelSession(data.sessionId);

    // 通过事件转发给 AppGateway，让它通知 iOS 客户端
    this.eventEmitter.emit('app.sendApprovalCancelled', {
      sessionId: data.sessionId,
      toolUseIds: data.toolUseIds,
    });
  }

  /**
   * 查询指定 session 的 pending approvals（供 AppGateway 使用）
   */
  getPendingApprovals(sessionId: string) {
    return this.approvalStateStore.getPendingApprovals(sessionId);
  }

  /**
   * 接收 ETerm 的会话创建结果（转发给 AppGateway → iOS）
   */
  @SubscribeMessage(DaemonEvents.SESSION_CREATED_RESULT)
  handleSessionCreatedResult(
    @MessageBody() data: {
      requestId: string;
      success: boolean;
      sessionId?: string;
      encodedDirName?: string;
      transcriptPath?: string;
      error?: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🖥️ [ETerm] Session 创建结果: requestId=${data.requestId} success=${data.success} sessionId=${data.sessionId || 'N/A'}`);

    // 从 pending Map 取出 projectPath
    const pending = this.pendingCreateRequests.get(data.requestId);
    this.pendingCreateRequests.delete(data.requestId);
    const projectPath = pending?.projectPath || '';

    if (data.success && data.sessionId) {
      // 通知 AppGateway 广播给 iOS
      this.eventEmitter.emit('app.etermSessionCreated', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        projectPath,
        timestamp: new Date().toISOString(),
      });
    }

    return { success: true };
  }

  /**
   * 接收 Daemon 的 SDK 错误通知（转发给 AppGateway）
   */
  @SubscribeMessage(DaemonEvents.SDK_ERROR)
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
  @SubscribeMessage(DaemonEvents.SWIFT_ACTIVITY)
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
  @SubscribeMessage(DaemonEvents.ETERM_ONLINE)
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
  @SubscribeMessage(DaemonEvents.ETERM_OFFLINE)
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

  // =================== ETerm 状态查询方法（从 StatusService 读取）===================

  /**
   * 检查 ETerm 是否在线
   * ETerm 设备 ID 固定为 "eterm"
   */
  async isEtermOnline(): Promise<boolean> {
    return this.statusService.isEtermOnline();
  }

  /**
   * 检查指定 session 是否在 ETerm 中可用
   */
  async isSessionInEterm(sessionId: string): Promise<boolean> {
    return this.statusService.isSessionInEterm(sessionId);
  }

  /**
   * 获取所有在 ETerm 中的 session（返回 sessionId 数组）
   */
  async getEtermSessions(): Promise<string[]> {
    return this.statusService.getEtermSessions();
  }

  /**
   * 获取每个项目的在线会话数（用于 iOS 项目列表显示）
   * @returns { [projectPath: string]: number }
   */
  async getEtermSessionCounts(): Promise<Record<string, number>> {
    return this.statusService.getSessionCountsByProject();
  }

  // =================== 新版状态事件处理（StatusManager）===================

  /**
   * 接收 ETerm 上线事件
   * 重构后：ETerm 只发事件，Server 通过 StatusService 管理状态
   */
  @SubscribeMessage(DaemonEvents.ONLINE)
  async handleDaemonOnline(
    @MessageBody() data: {
      deviceId: string;
      deviceName: string;
      platform: string;
      version: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🟢 [Status] 收到 daemon:online 事件`);
    this.logger.log(`   deviceId: ${data.deviceId}`);
    this.logger.log(`   deviceName: ${data.deviceName}`);
    this.logger.log(`   platform: ${data.platform}`);

    const daemonInfo: StatusDaemonInfo = {
      deviceId: data.deviceId,
      deviceName: data.deviceName,
      platform: data.platform,
      version: data.version,
      connectedAt: new Date(),
    };

    await this.statusService.handleDaemonOnline(data.deviceId, daemonInfo);

    return { success: true };
  }

  /**
   * 接收 ETerm 下线事件
   */
  @SubscribeMessage(DaemonEvents.OFFLINE)
  async handleDaemonOffline(
    @MessageBody() data: { deviceId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`🔴 [Status] Daemon 下线: ${data.deviceId}`);

    await this.statusService.handleDaemonOffline(data.deviceId);

    return { success: true };
  }

  /**
   * 接收 Session 开始事件
   */
  @SubscribeMessage(DaemonEvents.SESSION_START)
  async handleDaemonSessionStart(
    @MessageBody() data: {
      deviceId: string;
      sessionId: string;
      projectPath: string;
      terminalId?: number;
    },
    @ConnectedSocket() client: Socket,
  ) {
    this.diagLog('hook-in', 'SessionStart', data.sessionId);

    const sessionInfo: StatusSessionInfo = {
      sessionId: data.sessionId,
      projectPath: data.projectPath,
      terminalId: data.terminalId,
      startedAt: new Date(),
    };

    await this.statusService.handleSessionStart(data.deviceId, sessionInfo);

    return { success: true };
  }

  /**
   * 接收 Session 结束事件
   */
  @SubscribeMessage(DaemonEvents.SESSION_END)
  async handleDaemonSessionEnd(
    @MessageBody() data: { deviceId: string; sessionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.diagLog('hook-in', 'SessionEnd', data.sessionId);

    // 清理 Correlator 缓存 + 审批状态
    this.toolUseCorrelator.cleanup(data.sessionId);
    this.approvalStateStore.cleanup(data.sessionId);

    await this.statusService.handleSessionEnd(data.deviceId, data.sessionId);

    return { success: true };
  }

  /**
   * 接收心跳事件
   */
  @SubscribeMessage(DaemonEvents.HEARTBEAT)
  async handleDaemonHeartbeat(
    @MessageBody() data: { deviceId: string },
    @ConnectedSocket() client: Socket,
  ) {
    await this.statusService.handleHeartbeat(data.deviceId);

    return { success: true };
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
    this.server.emit(ServerEvents.INJECT_TO_ETERM, {
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

    // 存入 pending Map，供 sessionCreatedResult 回调时取出 projectPath
    if (requestId) {
      this.pendingCreateRequests.set(requestId, { projectPath, createdAt: Date.now() });
    }

    // 使用 CREATE_SESSION 事件（VlaudeKit 的 didReceiveCreateSessionNew handler）
    this.server.emit(ServerEvents.CREATE_SESSION, {
      projectPath,
      prompt,
      requestId,
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
    this.server.emit(ServerEvents.MOBILE_VIEWING, {
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
      this.server.emit(ServerEvents.SERVER_SHUTDOWN, {
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
