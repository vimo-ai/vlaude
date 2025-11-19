/**
 * @description WebSocket Gateway - 实时通信网关
 * @author Claude
 * @date 2025/11/16
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../shared/database/prisma.service';

// 客户端类型
type ClientType = 'swift' | 'cli';

// 客户端信息
interface ClientInfo {
  clientId: string;
  clientType: ClientType;
  sessionId?: string;
  projectPath?: string;
}

@WebSocketGateway({
  cors: {
    origin: '*', // 生产环境需要限制
  },
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AppGateway.name);

  // 会话订阅管理：sessionId -> { subscribers: Set<clientId>, projectPath: string }
  private sessionSubscriptions = new Map<string, { subscribers: Set<string>; projectPath: string }>();

  // 客户端管理：clientId -> ClientInfo
  private clients = new Map<string, ClientInfo>();

  // Session 的客户端类型管理：sessionId -> { cli: clientId | null, swift: Set<clientId> }
  private sessionClients = new Map<string, { cli: string | null; swift: Set<string> }>();

  // Daemon 服务地址
  private readonly DAEMON_URL = 'http://localhost:10006';

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`✅ 客户端连接: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`❌ 客户端断开: ${client.id}`);
    this.cleanupClient(client.id);
  }

  /**
   * CLI 切回 Local 模式，恢复 FileWatcher 推送
   */
  @SubscribeMessage('cli:resumeLocal')
  handleCliResumeLocal(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId } = data;
    this.logger.log(`📡 [CLI Resume Local] Session: ${sessionId}`);

    // 通知 Daemon 恢复 FileWatcher 推送
    this.eventEmitter.emit('daemon.resumeLocal', { sessionId });

    return { success: true };
  }

  /**
   * 客户端加入（CLI 或 Swift）
   */
  @SubscribeMessage('join')
  handleJoin(
    @MessageBody() data: { sessionId: string; clientType: ClientType; projectPath: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId, clientType, projectPath } = data;

    this.logger.log(`📱 [Join] 客户端加入: ${client.id}`);
    this.logger.log(`   Session: ${sessionId}`);
    this.logger.log(`   Type: ${clientType}`);
    this.logger.log(`   Project: ${projectPath}`);

    // 记录客户端信息
    this.clients.set(client.id, {
      clientId: client.id,
      clientType,
      sessionId,
      projectPath,
    });

    // 初始化 session 的客户端管理
    if (!this.sessionClients.has(sessionId)) {
      this.sessionClients.set(sessionId, {
        cli: null,
        swift: new Set(),
      });
    }

    const sessionClientInfo = this.sessionClients.get(sessionId)!;

    if (clientType === 'cli') {
      // CLI 客户端加入
      if (sessionClientInfo.cli) {
        this.logger.warn(`⚠️ Session ${sessionId} 已有 CLI 客户端，将替换`);
      }
      sessionClientInfo.cli = client.id;

      // 如果已经有 Swift 客户端在线，立即通知 CLI 进入 remote 模式
      if (sessionClientInfo.swift.size > 0) {
        this.logger.log(`📱 [Join] 检测到 Swift 客户端在线，通知 CLI 进入 remote 模式`);
        client.emit('remote-connect');
      }
    } else if (clientType === 'swift') {
      // Swift 客户端加入
      sessionClientInfo.swift.add(client.id);

      // 通知 CLI 客户端有 Swift 接管
      if (sessionClientInfo.cli) {
        this.logger.log(`📱 [Join] Swift 客户端加入，通知 CLI: ${sessionClientInfo.cli}`);
        this.server.to(sessionClientInfo.cli).emit('remote-connect');
      }
    }

    this.logger.log(`📊 [Join] Session ${sessionId} 客户端统计:`);
    this.logger.log(`   CLI: ${sessionClientInfo.cli || 'none'}`);
    this.logger.log(`   Swift: ${sessionClientInfo.swift.size} 个`);

    // V2: 通知 Daemon 有新会话被发现（可能是新项目）
    this.eventEmitter.emit('daemon.sessionDiscovered', {
      projectPath,
      sessionId,
    });

    return { success: true, message: `已加入 session ${sessionId}` };
  }

  /**
   * CLI 请求监听新 session 创建
   */
  @SubscribeMessage('watch-new-session')
  handleWatchNewSession(
    @MessageBody() data: { projectPath: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { projectPath } = data;

    this.logger.log(`👀 [监听新Session] CLI 请求监听: ${client.id}`);
    this.logger.log(`   项目路径: ${projectPath}`);

    // 通知 Daemon 开始监听新 session
    this.eventEmitter.emit('daemon.watchNewSession', {
      clientId: client.id,
      projectPath,
    });

    return { success: true, message: `开始监听项目的新 session: ${projectPath}` };
  }

  /**
   * CLI 请求查找新创建的 session
   */
  @SubscribeMessage('find-new-session')
  handleFindNewSession(
    @MessageBody() data: { projectPath: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { projectPath } = data;

    this.logger.log(`🔍 [查找新Session] CLI 请求查找: ${client.id}`);
    this.logger.log(`   项目路径: ${projectPath}`);

    // 通知 Daemon 查找新 session
    this.eventEmitter.emit('daemon.findNewSession', {
      clientId: client.id,
      projectPath,
    });

    return { success: true, message: `开始查找项目的新 session: ${projectPath}` };
  }

  /**
   * 客户端订阅某个会话的消息（兼容旧的 API）
   */
  @SubscribeMessage('session:subscribe')
  async handleSessionSubscribe(
    @MessageBody() data: { sessionId: string; projectPath: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId, projectPath } = data;

    this.logger.log(`📱 [Swift订阅] 客户端 ${client.id} 订阅会话 ${sessionId}`);
    this.logger.log(`   项目路径: ${projectPath}`);

    // 记录订阅关系
    if (!this.sessionSubscriptions.has(sessionId)) {
      this.sessionSubscriptions.set(sessionId, {
        subscribers: new Set(),
        projectPath,
      });
      this.logger.log(`🆕 [新会话订阅] ${sessionId}`);
    }

    const subscription = this.sessionSubscriptions.get(sessionId);
    const wasEmpty = subscription.subscribers.size === 0;
    subscription.subscribers.add(client.id);

    this.logger.log(
      `📊 [订阅统计] 会话 ${sessionId} 当前订阅数: ${subscription.subscribers.size}`,
    );

    // 如果是第一个订阅者，通知 Daemon 开始监听该会话文件
    if (wasEmpty) {
      this.logger.log(`🔔 [通知Daemon] 开始监听会话文件: ${sessionId}`);

      // V2: 只传递 projectPath，Daemon 内部查表
      this.eventEmitter.emit('daemon.startWatching', {
        sessionId,
        projectPath,
      });
    }

    return { success: true, message: `已订阅会话 ${sessionId}` };
  }

  /**
   * 客户端取消订阅
   */
  @SubscribeMessage('session:unsubscribe')
  handleSessionUnsubscribe(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId } = data;

    this.logger.log(
      `📱 [Swift取消订阅] 客户端 ${client.id} 取消订阅会话 ${sessionId}`,
    );

    const subscription = this.sessionSubscriptions.get(sessionId);
    if (subscription) {
      subscription.subscribers.delete(client.id);

      this.logger.log(
        `📊 [订阅统计] 会话 ${sessionId} 剩余订阅数: ${subscription.subscribers.size}`,
      );

      // 如果没有订阅者了，通知 Daemon 停止监听
      if (subscription.subscribers.size === 0) {
        this.logger.log(`🔕 [通知Daemon] 停止监听会话文件: ${sessionId}`);
        this.eventEmitter.emit('daemon.stopWatching', { sessionId, projectPath: subscription.projectPath });
        this.sessionSubscriptions.delete(sessionId);
      }
    }

    return { success: true, message: `已取消订阅会话 ${sessionId}` };
  }

  /**
   * Swift 客户端发送消息
   */
  @SubscribeMessage('message:send')
  async handleMessageSend(
    @MessageBody() data: { sessionId: string; text: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId, text } = data;

    this.logger.log(`📤 [消息发送] 收到来自 ${client.id} 的消息`);
    this.logger.log(`   Session: ${sessionId}`);
    this.logger.log(`   Text length: ${text.length}`);

    // 获取客户端信息
    const clientInfo = this.clients.get(client.id);
    if (!clientInfo) {
      this.logger.warn(`⚠️ [消息发送] 客户端 ${client.id} 未加入任何会话`);
      return { success: false, message: '请先加入会话' };
    }

    try {
      // V2: 只传递 projectPath，Daemon 内部查表
      const response = await firstValueFrom(
        this.httpService.post(`${this.DAEMON_URL}/sessions/send-message`, {
          sessionId,
          text,
          projectPath: clientInfo.projectPath,
        }),
      );

      this.logger.log(`✅ [消息发送] Daemon 响应: ${JSON.stringify(response.data)}`);

      return response.data;
    } catch (error) {
      this.logger.error(`❌ [消息发送] 转发失败: ${error.message}`, error.stack);
      return { success: false, message: `转发失败: ${error.message}` };
    }
  }

  /**
   * Daemon 调用：推送新消息到订阅了该会话的客户端
   */
  notifyNewMessage(sessionId: string, message: any) {
    const subscription = this.sessionSubscriptions.get(sessionId);

    // 调试日志：显示当前所有订阅
    this.logger.log(`🔍 [调试] notifyNewMessage 被调用: sessionId=${sessionId}`);
    this.logger.log(`🔍 [调试] 当前 sessionSubscriptions 大小: ${this.sessionSubscriptions.size}`);
    this.logger.log(`🔍 [调试] 当前所有订阅的 session: ${Array.from(this.sessionSubscriptions.keys()).join(', ')}`);

    if (subscription && subscription.subscribers.size > 0) {
      this.logger.log(`🔍 [调试] 找到订阅: ${subscription.subscribers.size} 个客户端`);
      subscription.subscribers.forEach((clientId) => {
        this.logger.log(`🔍 [调试] 推送到客户端: ${clientId}`);
        this.server.to(clientId).emit('message:new', {
          sessionId,
          message,
        });
      });
      this.logger.log(
        `📨 推送新消息到 ${subscription.subscribers.size} 个客户端: ${sessionId}`,
      );
    } else {
      this.logger.warn(`⚠️ [警告] 没有找到会话订阅或订阅者为空: ${sessionId}`);
    }
  }

  /**
   * Daemon 调用：通知 CLI 新 session 已创建
   */
  notifyNewSessionFound(clientId: string, sessionId: string, projectPath: string) {
    this.logger.log(`✅ [新Session查找] 通知 CLI: ${clientId}`);
    this.logger.log(`   SessionId: ${sessionId}`);
    this.logger.log(`   ProjectPath: ${projectPath}`);

    this.server.to(clientId).emit('new-session-found', {
      sessionId,
      projectPath,
    });
  }

  notifyNewSessionNotFound(clientId: string) {
    this.logger.log(`❌ [新Session查找] 通知 CLI 未找到: ${clientId}`);

    this.server.to(clientId).emit('new-session-not-found', {});
  }

  notifyWatchStarted(clientId: string, projectPath: string) {
    this.logger.log(`👀 [监听器启动] 通知 CLI: ${clientId}`);
    this.logger.log(`   ProjectPath: ${projectPath}`);

    this.server.to(clientId).emit('watch-started', {
      projectPath,
    });
  }

  notifyNewSessionCreated(clientId: string, sessionId: string, projectPath: string) {
    this.logger.log(`🆕 [新Session创建] 通知 CLI: ${clientId}`);
    this.logger.log(`   SessionId: ${sessionId}`);
    this.logger.log(`   ProjectPath: ${projectPath}`);

    this.server.to(clientId).emit('new-session-created', {
      sessionId,
      projectPath,
    });
  }

  /**
   * Daemon 调用：广播项目更新
   */
  notifyProjectUpdate(projectPath: string, metadata?: any) {
    this.server.emit('project:updated', {
      projectPath,
      metadata,
    });
    this.logger.log(`🔄 广播项目更新: ${projectPath}`);
  }

  /**
   * Daemon 调用：广播会话元数据更新
   */
  notifySessionUpdate(sessionId: string, metadata: any) {
    this.server.emit('session:updated', {
      sessionId,
      metadata,
    });
    this.logger.log(`📝 广播会话更新: ${sessionId}`);
  }

  /**
   * 监听来自 DaemonGateway 的新 session 查找成功事件
   */
  @OnEvent('app.notifyNewSessionFound')
  handleNotifyNewSessionFoundEvent(data: { clientId: string; sessionId: string; projectPath: string; encodedDirName: string }) {
    this.logger.log(`📥 [事件监听] 收到新Session查找成功事件: ${data.sessionId}`);
    this.notifyNewSessionFound(data.clientId, data.sessionId, data.projectPath);
  }

  /**
   * 监听来自 DaemonGateway 的未找到 session 事件
   */
  @OnEvent('app.notifyNewSessionNotFound')
  handleNotifyNewSessionNotFoundEvent(data: { clientId: string; projectPath: string }) {
    this.logger.log(`📥 [事件监听] 收到未找到新Session事件`);
    this.notifyNewSessionNotFound(data.clientId);
  }

  /**
   * 监听来自 DaemonGateway 的监听器启动事件
   */
  @OnEvent('app.notifyWatchStarted')
  handleNotifyWatchStartedEvent(data: { clientId: string; projectPath: string }) {
    this.logger.log(`📥 [事件监听] 收到监听器启动事件`);
    this.notifyWatchStarted(data.clientId, data.projectPath);
  }

  /**
   * 监听来自 DaemonGateway 的新 session 创建事件
   */
  @OnEvent('app.notifyNewSessionCreated')
  handleNotifyNewSessionCreatedEvent(data: { clientId: string; sessionId: string; projectPath: string }) {
    this.logger.log(`📥 [事件监听] 收到新Session创建事件: ${data.sessionId}`);
    this.notifyNewSessionCreated(data.clientId, data.sessionId, data.projectPath);
  }

  /**
   * 清理客户端（包括订阅和 join 信息）
   */
  private cleanupClient(clientId: string) {
    const clientInfo = this.clients.get(clientId);

    if (clientInfo) {
      this.logger.log(`🧹 [清理] 客户端断开: ${clientId}`);
      this.logger.log(`   Type: ${clientInfo.clientType}`);
      this.logger.log(`   Session: ${clientInfo.sessionId || 'none'}`);

      // 清理 session clients
      if (clientInfo.sessionId) {
        const sessionClientInfo = this.sessionClients.get(clientInfo.sessionId);
        if (sessionClientInfo) {
          if (clientInfo.clientType === 'cli') {
            // CLI 断开
            if (sessionClientInfo.cli === clientId) {
              sessionClientInfo.cli = null;
              this.logger.log(`   CLI 客户端已移除`);
            }
          } else if (clientInfo.clientType === 'swift') {
            // Swift 断开
            sessionClientInfo.swift.delete(clientId);
            this.logger.log(`   Swift 客户端已移除，剩余: ${sessionClientInfo.swift.size}`);

            // 如果没有 Swift 客户端了，通知 CLI 恢复 local 模式
            if (sessionClientInfo.swift.size === 0 && sessionClientInfo.cli) {
              this.logger.log(`📱 [断开] 所有 Swift 断开，通知 CLI 恢复 local 模式: ${sessionClientInfo.cli}`);
              this.server.to(sessionClientInfo.cli).emit('remote-disconnect');
            }
          }

          // 如果 session 没有任何客户端了，删除记录
          if (!sessionClientInfo.cli && sessionClientInfo.swift.size === 0) {
            this.sessionClients.delete(clientInfo.sessionId);
            this.logger.log(`   Session ${clientInfo.sessionId} 所有客户端已断开`);
          }
        }
      }

      // 从客户端列表移除
      this.clients.delete(clientId);
    }

    // 清理旧的订阅管理（兼容）
    this.sessionSubscriptions.forEach((subscription, sessionId) => {
      subscription.subscribers.delete(clientId);

      // 如果没有订阅者了，通知 Daemon 停止监听
      if (subscription.subscribers.size === 0) {
        this.logger.log(`🧹 [清理] 停止监听会话: ${sessionId}`);
        this.eventEmitter.emit('daemon.stopWatching', { sessionId, projectPath: subscription.projectPath });
        this.sessionSubscriptions.delete(sessionId);
      }
    });
  }

  /**
   * 监听来自 DaemonGateway 的新消息事件
   */
  @OnEvent('app.notifyNewMessage')
  handleNotifyNewMessageEvent(data: { sessionId: string; message: any }) {
    this.logger.log(`📥 [事件监听] 收到新消息事件: ${data.sessionId}`);
    this.notifyNewMessage(data.sessionId, data.message);
  }

  /**
   * 监听来自 DaemonGateway 的项目更新事件
   */
  @OnEvent('app.notifyProjectUpdate')
  handleNotifyProjectUpdateEvent(data: { projectPath: string; metadata?: any }) {
    this.logger.log(`📥 [事件监听] 收到项目更新事件: ${data.projectPath}`);
    this.notifyProjectUpdate(data.projectPath, data.metadata);
  }

  /**
   * 监听来自 DaemonGateway 的会话更新事件
   */
  @OnEvent('app.notifySessionUpdate')
  handleNotifySessionUpdateEvent(data: { sessionId: string; metadata: any }) {
    this.logger.log(`📥 [事件监听] 收到会话更新事件: ${data.sessionId}`);
    this.notifySessionUpdate(data.sessionId, data.metadata);
  }
}
