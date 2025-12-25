import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { io, Socket } from 'socket.io-client';
import { ServiceRegistry, ServiceEvent } from '@vimo-ai/vlaude-shared-core';

/**
 * Socket.IO Client Service
 * 连接到 vlaude-server,实现 daemon 与 server 的通信
 */
@Injectable()
export class ServerClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServerClientService.name);
  private socket: Socket;
  private serverUrl: string;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private dataCollectorService: any; // 延迟注入避免循环依赖

  // 权限请求 Promise 管理
  private approvalPromises = new Map<string, {
    resolve: (result: { approved: boolean; reason?: string }) => void;
    reject: (error: Error) => void;
  }>();

  // 服务发现相关
  private registry: ServiceRegistry | null = null;
  private availableServers: string[] = [];
  private currentServerIndex = -1;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    // 从环境变量获取 server URL（mTLS 模式使用 https）
    this.serverUrl = this.configService.get<string>('SERVER_URL') || 'https://localhost:10005';
  }

  /**
   * 设置 DataCollectorService（延迟注入避免循环依赖）
   */
  setDataCollectorService(service: any) {
    this.dataCollectorService = service;
  }

  async onModuleInit() {
    await this.initRegistry();
    await this.connect();
  }

  async onModuleDestroy() {
    await this.cleanup();
  }

  /**
   * 初始化服务注册中心
   */
  private async initRegistry() {
    try {
      // 从环境变量获取 Redis 配置
      const redisHost = this.configService.get<string>('REDIS_HOST') || '10.0.0.1';
      const redisPort = this.configService.get<number>('REDIS_PORT') || 6379;
      const redisPassword = this.configService.get<string>('REDIS_PASSWORD');

      this.logger.log(`初始化服务发现 (Redis: ${redisHost}:${redisPort})`);

      // 创建 ServiceRegistry 实例
      this.registry = new ServiceRegistry({
        host: redisHost,
        port: redisPort,
        password: redisPassword,
        keyPrefix: 'vlaude:',
      });

      // 订阅服务事件
      await this.registry.subscribe(this.handleServiceEvent.bind(this));

      // 获取可用的 Server 列表
      this.availableServers = await this.registry.getServers();
      this.logger.log(`📋 发现 ${this.availableServers.length} 个可用 Server: ${this.availableServers.join(', ')}`);

      // 选择最高优先级的 Server
      if (this.availableServers.length > 0) {
        this.currentServerIndex = 0;
        this.serverUrl = `https://${this.availableServers[0]}`;
        this.logger.log(`🎯 选择 Server: ${this.serverUrl}`);
      } else {
        this.logger.warn('⚠️ Redis 中未发现可用 Server，使用环境变量配置');
      }
    } catch (error) {
      this.logger.error(`❌ 服务发现初始化失败: ${error.message}`);
      this.logger.warn('将使用环境变量配置的 Server URL');
      this.registry = null;
    }
  }

  /**
   * 处理服务注册事件
   */
  private async handleServiceEvent(event: ServiceEvent) {
    const { type, service, address } = event;

    // 只处理 server 服务的事件
    if (service !== 'server') {
      return;
    }

    this.logger.log(`📡 收到服务事件: ${type} - server@${address}`);

    if (type === 'online') {
      // 新 Server 上线
      await this.handleServerOnline(address);
    } else if (type === 'offline') {
      // Server 下线
      await this.handleServerOffline(address);
    }
  }

  /**
   * 处理 Server 上线事件
   */
  private async handleServerOnline(address: string) {
    if (!this.registry) {
      return;
    }

    // 刷新可用 Server 列表
    this.availableServers = await this.registry.getServers();
    this.logger.log(`📋 更新 Server 列表: ${this.availableServers.join(', ')}`);

    // 检查新 Server 的优先级
    const newServerIndex = this.availableServers.indexOf(address);
    if (newServerIndex === -1) {
      return;
    }

    // 如果新 Server 优先级更高（索引更小），切换连接
    if (this.currentServerIndex === -1 || newServerIndex < this.currentServerIndex) {
      this.logger.log(`🔄 发现更高优先级的 Server: ${address}，准备切换连接`);
      await this.switchServer(newServerIndex);
    }
  }

  /**
   * 处理 Server 下线事件
   */
  private async handleServerOffline(address: string) {
    if (!this.registry) {
      return;
    }

    // 刷新可用 Server 列表
    this.availableServers = await this.registry.getServers();
    this.logger.log(`📋 更新 Server 列表: ${this.availableServers.join(', ')}`);

    // 如果下线的是当前连接的 Server
    const currentAddress = this.getCurrentServerAddress();
    if (currentAddress === address) {
      this.logger.warn(`⚠️ 当前连接的 Server 下线: ${address}，准备切换到下一个可用 Server`);

      // 切换到下一个可用的 Server
      if (this.availableServers.length > 0) {
        await this.switchServer(0);
      } else {
        this.logger.error('❌ 没有可用的 Server，等待 Server 上线');
        this.currentServerIndex = -1;
      }
    } else {
      // 更新当前 Server 索引
      if (this.availableServers.length > 0) {
        this.currentServerIndex = this.availableServers.indexOf(currentAddress);
      }
    }
  }

  /**
   * 切换到指定的 Server
   */
  private async switchServer(serverIndex: number) {
    if (serverIndex < 0 || serverIndex >= this.availableServers.length) {
      this.logger.error(`❌ 无效的 Server 索引: ${serverIndex}`);
      return;
    }

    const newAddress = this.availableServers[serverIndex];
    const newServerUrl = `https://${newAddress}`;

    this.logger.log(`🔄 切换到 Server: ${newServerUrl}`);

    // 断开当前连接
    if (this.socket) {
      this.socket.disconnect();
    }

    // 更新 Server URL 和索引
    this.serverUrl = newServerUrl;
    this.currentServerIndex = serverIndex;

    // 重新连接
    await this.connect();
  }

  /**
   * 获取当前连接的 Server 地址
   */
  private getCurrentServerAddress(): string | null {
    if (this.currentServerIndex === -1 || !this.availableServers[this.currentServerIndex]) {
      return null;
    }
    return this.availableServers[this.currentServerIndex];
  }

  /**
   * 连接到 server
   */
  private async connect() {
    // 连接到 DaemonGateway 的命名空间
    const daemonUrl = `${this.serverUrl}/daemon`;
    this.logger.log(`Connecting to server at ${daemonUrl}`);

    this.socket = io(daemonUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: this.maxReconnectAttempts,
      // 内网跳过证书验证（mTLS 场景）
      rejectUnauthorized: false,
    });

    this.setupEventHandlers();
  }

  /**
   * 设置事件监听器
   */
  private setupEventHandlers() {
    this.socket.on('connect', () => {
      this.reconnectAttempts = 0;
      // 注册 daemon
      this.registerDaemon();
      // 触发连接成功事件，让 DataCollectorService 可以开始采集数据
      this.eventEmitter.emit('server.connected');
    });

    this.socket.on('disconnect', (reason) => {
      this.logger.warn(`Disconnected from server: ${reason}`);
    });

    this.socket.on('connect_error', (error) => {
      this.reconnectAttempts++;
      this.logger.error(`Connection error (attempt ${this.reconnectAttempts}): ${error.message}`);
    });

    this.socket.on('reconnect', (attemptNumber) => {
      this.logger.log(`Reconnected to server after ${attemptNumber} attempts`);
    });

    this.socket.on('reconnect_failed', () => {
      this.logger.error('Failed to reconnect to server after max attempts');
    });

    // 监听来自 server 的指令
    this.socket.on('server:command', (data) => {
      this.handleServerCommand(data);
    });

    // 监听来自 server 的会话消息请求
    this.socket.on('server:requestSessionMessages', async (data, callback) => {
      await this.handleSessionMessagesRequest(data, callback);
    });

    // 监听来自 server 的开始监听请求
    this.socket.on('server:startWatching', async (data) => {
      await this.handleStartWatchingRequest(data);
    });

    // 监听来自 server 的停止监听请求
    this.socket.on('server:stopWatching', async (data) => {
      await this.handleStopWatchingRequest(data);
    });

    // 监听 CLI 切回 Local 模式，恢复 FileWatcher 推送
    this.socket.on('server:resumeLocal', async (data) => {
      this.logger.log(`📡 [Resume Local] 收到恢复推送请求: ${data.sessionId}`);
      this.eventEmitter.emit('session.resumePush', { sessionId: data.sessionId });
    });

    // 监听来自 server 的监听新 session 请求
    this.socket.on('server:watchNewSession', async (data) => {
      this.logger.log(`📡 [Watch New Session] 收到监听新Session请求`);
      this.logger.log(`   CLI ID: ${data.clientId}`);
      this.logger.log(`   项目路径: ${data.projectPath}`);
      this.eventEmitter.emit('daemon.watchNewSession', {
        clientId: data.clientId,
        projectPath: data.projectPath,
      });
    });

    // 监听来自 server 的查找新 session 请求
    this.socket.on('server:findNewSession', async (data) => {
      this.logger.log(`🔍 [Find New Session] 收到查找新Session请求`);
      this.logger.log(`   CLI ID: ${data.clientId}`);
      this.logger.log(`   项目路径: ${data.projectPath}`);
      this.eventEmitter.emit('daemon.findNewSession', {
        clientId: data.clientId,
        projectPath: data.projectPath,
      });
    });

    // 监听来自 server 的新会话发现事件
    this.socket.on('server:sessionDiscovered', async (data) => {
      await this.handleSessionDiscovered(data);
    });

    // 监听来自 server 的权限响应
    this.socket.on('server:approvalResponse', (data: { requestId: string; approved: boolean; reason?: string }) => {
      this.handleApprovalResponse(data);
    });

    // =================== ETerm 相关事件监听 ===================

    // 监听来自 server 的消息注入请求（转发给 ETerm）
    this.socket.on('server:injectToEterm', (data: { sessionId: string; text: string }) => {
      this.logger.log(`💉 [ETerm] 收到消息注入请求: session=${data.sessionId}`);
      this.eventEmitter.emit('eterm.inject', data);
    });

    // 监听来自 server 的 Mobile 查看状态通知（转发给 ETerm）
    this.socket.on('server:mobileViewing', (data: { sessionId: string; isViewing: boolean }) => {
      this.logger.log(`📱 [ETerm] Mobile ${data.isViewing ? '正在查看' : '离开了'} session ${data.sessionId}`);
      this.eventEmitter.emit('eterm.mobileViewing', data);
    });

    // 监听来自 server 的创建会话请求（转发给 ETerm）
    this.socket.on('server:createSessionInEterm', (data: { projectPath: string; prompt?: string; requestId?: string }) => {
      this.logger.log(`🖥️ [ETerm] 收到创建会话请求: projectPath=${data.projectPath}, requestId=${data.requestId || 'N/A'}`);
      this.eventEmitter.emit('eterm.createSession', data);
    });
  }

  /**
   * 注册 daemon 到 server
   */
  private registerDaemon() {
    const hostname = require('os').hostname();
    const platform = process.platform;

    this.socket.emit('daemon:register', {
      hostname,
      platform,
      version: '0.0.1',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 处理来自 server 的指令
   */
  private handleServerCommand(data: any) {
    this.logger.log(`Received command from server: ${JSON.stringify(data)}`);
    // 后续会根据不同的命令类型分发到对应的处理器
  }

  /**
   * 处理会话消息请求
   */
  private async handleSessionMessagesRequest(
    data: { sessionId: string; projectPath: string; limit?: number; offset?: number; order?: 'asc' | 'desc' },
    callback: Function,
  ) {
    this.logger.log(
      `Received session messages request: ${data.sessionId} (limit: ${data.limit || 50}, offset: ${data.offset || 0}, order: ${data.order || 'asc'})`,
    );

    if (!this.dataCollectorService) {
      this.logger.error('DataCollectorService not set');
      callback({ success: false, error: 'Service not available' });
      return;
    }

    try {
      const result = await this.dataCollectorService.getSessionMessages(
        data.sessionId,
        data.projectPath,
        data.limit || 50,
        data.offset || 0,
        data.order || 'asc',
      );

      if (result === null) {
        callback({ success: false, error: 'Session not found' });
      } else {
        callback({
          success: true,
          messages: result.messages,
          total: result.total,
          hasMore: result.hasMore,
        });
      }
    } catch (error) {
      this.logger.error(`Failed to get session messages: ${error.message}`);
      callback({ success: false, error: error.message });
    }
  }

  /**
   * 清理资源
   */
  private async cleanup() {
    // 断开 Socket 连接
    if (this.socket) {
      this.socket.disconnect();
      this.logger.log('Disconnected from server');
    }

    // 断开 Redis 连接
    if (this.registry) {
      await this.registry.disconnect();
      this.logger.log('Disconnected from Redis registry');
    }
  }

  /**
   * 向 server 发送项目数据
   */
  async sendProjectData(projects: any[]) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot send project data');
      return false;
    }

    return new Promise<boolean>((resolve) => {
      this.socket.emit('daemon:projectData', { projects }, (response: any) => {
        if (response?.success) {
          this.logger.log(`Sent ${projects.length} projects to server`);
          resolve(true);
        } else {
          this.logger.error('Failed to send project data to server');
          resolve(false);
        }
      });
    });
  }

  /**
   * 向 server 发送会话元数据（批量）
   */
  async sendSessionMetadata(projectPath: string, sessions: any[]) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot send session metadata');
      return false;
    }

    return new Promise<boolean>((resolve) => {
      this.socket.emit(
        'daemon:sessionMetadata',
        { projectPath, sessions },
        (response: any) => {
          if (response?.success) {
            this.logger.log(`Sent ${sessions.length} session metadata for project ${projectPath}`);
            resolve(true);
          } else {
            this.logger.error(`Failed to send session metadata for ${projectPath}`);
            resolve(false);
          }
        },
      );
    });
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /**
   * 获取 socket 实例 (供其他服务使用)
   */
  getSocket(): Socket {
    return this.socket;
  }

  /**
   * 通知 Server 推送新消息到客户端
   */
  async notifyNewMessage(sessionId: string, message: any) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify new message');
      return false;
    }

    this.socket.emit('daemon:newMessage', {
      sessionId,
      message,
    });

    this.logger.log(`Notified server of new message in session ${sessionId}`);
    return true;
  }

  /**
   * 通知 Server 推送 Metrics 更新到客户端
   */
  async notifyMetricsUpdate(sessionId: string, metrics: any) {
    if (!this.isConnected()) {
      this.logger.warn('未连接到 Server，无法推送 Metrics');
      return false;
    }

    this.socket.emit('daemon:metricsUpdate', {
      sessionId,
      metrics,
    });

    return true;
  }

  /**
   * 通知 Server 找到了新 session
   */
  async notifyNewSessionFound(clientId: string, sessionId: string, projectPath: string, encodedDirName: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify session found');
      return false;
    }

    this.socket.emit('daemon:newSessionFound', {
      clientId,
      sessionId,
      projectPath,
      encodedDirName,
    });

    this.logger.log(`📤 [通知 Server] 找到新Session: sessionId=${sessionId}`);
    return true;
  }

  /**
   * 通知 Server 未找到新 session
   */
  async notifyNewSessionNotFound(clientId: string, projectPath: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify session not found');
      return false;
    }

    this.socket.emit('daemon:newSessionNotFound', {
      clientId,
      projectPath,
    });

    this.logger.log(`📤 [通知 Server] 未找到新Session`);
    return true;
  }

  /**
   * 通知 Server 监听器已启动
   */
  async notifyWatchStarted(clientId: string, projectPath: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify watch started');
      return false;
    }

    this.socket.emit('daemon:watchStarted', {
      clientId,
      projectPath,
    });

    this.logger.log(`📤 [通知 Server] 监听器已启动: clientId=${clientId}`);
    return true;
  }

  /**
   * 通知 Server 新 session 已创建
   */
  async notifyNewSessionCreated(clientId: string, sessionId: string, projectPath: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify new session created');
      return false;
    }

    this.socket.emit('daemon:newSessionCreated', {
      clientId,
      sessionId,
      projectPath,
    });

    this.logger.log(`🆕 [通知新Session] clientId=${clientId}, sessionId=${sessionId}`);
    return true;
  }

  /**
   * 通知 Server 推送项目更新到客户端
   */
  async notifyProjectUpdate(projectPath: string, metadata?: any) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify project update');
      return false;
    }

    this.socket.emit('daemon:projectUpdate', {
      projectPath,
      metadata,
    });

    this.logger.log(`Notified server of project update: ${projectPath}`);
    return true;
  }

  /**
   * 通知 Server 推送会话更新到客户端
   */
  async notifySessionUpdate(sessionId: string, metadata: any) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify session update');
      return false;
    }

    this.socket.emit('daemon:sessionUpdate', {
      sessionId,
      metadata,
    });

    this.logger.log(`Notified server of session update: ${sessionId}`);
    return true;
  }

  /**
   * 处理 Server 请求开始监听会话文件
   */
  private async handleStartWatchingRequest(data: { sessionId: string; projectPath: string }) {
    const { sessionId, projectPath } = data;

    this.logger.log(`📥 [Server请求] 开始监听会话: ${sessionId}`);
    this.logger.log(`   项目路径: ${projectPath}`);

    if (this.dataCollectorService) {
      await this.dataCollectorService.startWatchingSession(sessionId, projectPath);

      // 开始监听后，立即推送一次当前的 metrics
      this.dataCollectorService.pushInitialMetrics(sessionId, projectPath).catch(err => {
        this.logger.warn(`初始 Metrics 推送失败: ${err.message}`);
      });
    } else {
      this.logger.error('❌ DataCollectorService not available');
    }
  }

  /**
   * 处理 Server 请求停止监听会话文件
   */
  private async handleStopWatchingRequest(data: { sessionId: string; projectPath: string }) {
    const { sessionId, projectPath } = data;

    this.logger.log(`📥 [Server请求] 停止监听会话: ${sessionId}`);

    if (this.dataCollectorService) {
      await this.dataCollectorService.stopWatchingSession(sessionId);
    } else {
      this.logger.error('❌ DataCollectorService not available');
    }
  }

  /**
   * 处理 Server 通知的新会话发现事件
   */
  private async handleSessionDiscovered(data: { projectPath: string; sessionId: string }) {
    const { projectPath, sessionId } = data;

    this.logger.log(`📥 [新会话发现] 项目: ${projectPath}, 会话: ${sessionId}`);

    if (this.dataCollectorService) {
      // 刷新项目路径映射（如果是新项目）
      await this.dataCollectorService.refreshProjectMapping(projectPath);
    } else {
      this.logger.error('❌ DataCollectorService not available');
    }
  }

  // =================== V2 架构新增通知方法 ===================

  /**
   * 通知 Server 项目列表已更新
   */
  async notifyProjectListUpdate() {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify project list update');
      return false;
    }

    this.socket.emit('daemon:projectListUpdate');
    this.logger.log('📤 通知 Server: 项目列表已更新');
    return true;
  }

  /**
   * 通知 Server 会话列表已更新
   */
  async notifySessionListUpdate(projectPath: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify session list update');
      return false;
    }

    this.socket.emit('daemon:sessionListUpdate', { projectPath });
    this.logger.log(`📤 通知 Server: 会话列表已更新 (${projectPath})`);
    return true;
  }

  /**
   * 通知 Server 会话详情已更新 (需要增量解析)
   */
  async notifySessionDetailUpdate(sessionId: string, projectPath: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify session detail update');
      return false;
    }

    this.socket.emit('daemon:sessionDetailUpdate', { sessionId, projectPath });
    this.logger.log(`📤 通知 Server: 会话详情已更新 (${sessionId})`);
    return true;
  }

  /**
   * 通知 Server 会话文件已恢复
   */
  async notifySessionRestored(sessionId: string, projectPath: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify session restored');
      return false;
    }

    this.socket.emit('daemon:sessionRestored', { sessionId, projectPath });
    this.logger.log(`♻️ 通知 Server: 会话已恢复 (${sessionId})`);
    return true;
  }

  /**
   * 通知 Server 会话文件已删除 (软删除)
   */
  async notifySessionDeleted(sessionId: string, projectPath: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify session deleted');
      return false;
    }

    this.socket.emit('daemon:sessionDeleted', { sessionId, projectPath });
    this.logger.log(`🗑️ 通知 Server: 会话已删除 (${sessionId})`);
    return true;
  }

  // =================== 权限请求相关方法 ===================

  /**
   * 请求用户权限确认
   * @param sessionId 会话 ID
   * @param clientId 客户端 ID (iOS)
   * @param toolName 工具名称
   * @param input 工具参数
   * @param toolUseID 工具调用 ID
   * @param timeout 超时时间（毫秒）
   * @returns Promise<{ approved: boolean; reason?: string }>
   */
  async requestApproval(
    sessionId: string,
    clientId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseID: string,
    timeout = 60000,
  ): Promise<{ approved: boolean; reason?: string }> {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot request approval');
      return { approved: false, reason: 'Server 未连接' };
    }

    const requestId = `${sessionId}-${toolUseID}`;

    this.logger.log(`🔐 [权限请求] 发送给 iOS 客户端`);
    this.logger.log(`   RequestID: ${requestId}`);
    this.logger.log(`   Tool: ${toolName}`);
    this.logger.log(`   SessionID: ${sessionId}`);

    // 发送权限请求给 Server
    this.socket.emit('daemon:approvalRequest', {
      requestId,
      sessionId,
      clientId,
      toolName,
      input,
      toolUseID,
      description: this.formatToolDescription(toolName, input),
    });

    // 等待响应
    return new Promise((resolve, reject) => {
      // 保存 Promise 的 resolve/reject
      this.approvalPromises.set(requestId, { resolve, reject });

      // 设置超时
      setTimeout(() => {
        if (this.approvalPromises.has(requestId)) {
          this.approvalPromises.delete(requestId);
          this.logger.warn(`⚠️ [权限请求] 超时: ${requestId}`);

          // 发送超时通知给前端（通过 Server）
          this.socket.emit('daemon:approvalTimeout', {
            requestId,
            sessionId,
            clientId,
          });
          this.logger.log(`📤 [权限超时] 已通知前端: ${clientId}`);

          resolve({ approved: false, reason: '请求超时' });
        }
      }, timeout);
    });
  }

  /**
   * 处理来自 Server 的权限响应
   */
  private handleApprovalResponse(data: { requestId: string; approved: boolean; reason?: string }) {
    const { requestId, approved, reason } = data;

    this.logger.log(`✅ [权限响应] 收到响应: ${requestId}`);
    this.logger.log(`   批准: ${approved}`);
    if (reason) {
      this.logger.log(`   原因: ${reason}`);
    }

    const promise = this.approvalPromises.get(requestId);
    if (promise) {
      promise.resolve({ approved, reason });
      this.approvalPromises.delete(requestId);
    } else {
      this.logger.warn(`⚠️ [权限响应] 未找到对应的请求: ${requestId}`);

      // 通知前端：这是一个延迟响应，请求已超时
      this.socket.emit('daemon:approvalExpired', {
        requestId,
        message: '权限请求已超时，请重新发起操作',
      });
      this.logger.log(`📤 [延迟响应] 已通知前端请求已过期`);
    }
  }

  /**
   * 格式化工具描述（给用户看的友好文本）
   */
  private formatToolDescription(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash':
        return `执行命令: ${input.command}`;
      case 'Write':
        return `写入文件: ${input.file_path}`;
      case 'Edit':
        return `修改文件: ${input.file_path}`;
      case 'Delete':
        return `删除文件: ${input.file_path}`;
      default:
        return `调用工具: ${toolName}`;
    }
  }

  /**
   * 通知前端 SDK 错误（停止 loading）
   */
  async notifySDKError(sessionId: string, clientId: string, error: { type: string; message: string }) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify SDK error');
      return false;
    }

    this.socket.emit('daemon:sdkError', {
      sessionId,
      clientId,
      error,
    });

    this.logger.log(`📤 [SDK 错误] 已通知前端: ${clientId}`);
    this.logger.log(`   Type: ${error.type}`);
    this.logger.log(`   Message: ${error.message}`);
    return true;
  }

  /**
   * 通知 Server：Swift 正在活动，检查是否需要重新进入 remote mode
   */
  async notifySwiftActivity(sessionId: string, projectPath: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify Swift activity');
      return false;
    }

    this.socket.emit('daemon:swiftActivity', {
      sessionId,
      projectPath,
    });

    this.logger.log(`📤 [Swift 活动] 已通知 Server: ${sessionId}`);
    return true;
  }

  // =================== ETerm 相关通知方法 ===================

  /**
   * 通知 Server：ETerm 已上线
   */
  async notifyEtermOnline() {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify ETerm online');
      return false;
    }

    this.socket.emit('daemon:etermOnline', {
      timestamp: new Date().toISOString(),
    });

    this.logger.log('🖥️ [ETerm] 已通知 Server: ETerm 在线');
    return true;
  }

  /**
   * 通知 Server：ETerm 已离线
   */
  async notifyEtermOffline() {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify ETerm offline');
      return false;
    }

    this.socket.emit('daemon:etermOffline', {
      timestamp: new Date().toISOString(),
    });

    this.logger.log('🖥️ [ETerm] 已通知 Server: ETerm 离线');
    return true;
  }

  /**
   * 通知 Server：某个 session 在 ETerm 中可用
   */
  async notifyEtermSessionAvailable(sessionId: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify ETerm session available');
      return false;
    }

    this.socket.emit('daemon:etermSessionAvailable', {
      sessionId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`🖥️ [ETerm] 已通知 Server: Session ${sessionId} 在 ETerm 中可用`);
    return true;
  }

  /**
   * 通知 Server：某个 session 不再在 ETerm 中可用
   */
  async notifyEtermSessionUnavailable(sessionId: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify ETerm session unavailable');
      return false;
    }

    this.socket.emit('daemon:etermSessionUnavailable', {
      sessionId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`🖥️ [ETerm] 已通知 Server: Session ${sessionId} 不再在 ETerm 中可用`);
    return true;
  }

  /**
   * 通知 Server：ETerm 会话创建完成（带 requestId）
   */
  async notifyEtermSessionCreated(requestId: string, sessionId: string, projectPath: string) {
    if (!this.isConnected()) {
      this.logger.warn('Not connected to server, cannot notify ETerm session created');
      return false;
    }

    this.socket.emit('daemon:etermSessionCreated', {
      requestId,
      sessionId,
      projectPath,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`🖥️ [ETerm] 已通知 Server: Session 创建完成`);
    this.logger.log(`   RequestId: ${requestId}`);
    this.logger.log(`   SessionId: ${sessionId}`);
    this.logger.log(`   ProjectPath: ${projectPath}`);
    return true;
  }
}
