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

/**
 * WebSocket Gateway for CLI communication
 * 供 CLI 客户端连接,实现实时通信
 */
@WebSocketGateway(10007, {
  cors: {
    origin: '*',
  },
  transports: ['websocket'],
})
export class VlaudeWebSocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(VlaudeWebSocketGateway.name);
  private connectedClients = new Map<string, Socket>();

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized on port 10007');
  }

  handleConnection(client: Socket) {
    this.logger.log(`CLI Client connected: ${client.id}`);
    this.connectedClients.set(client.id, client);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`CLI Client disconnected: ${client.id}`);
    this.connectedClients.delete(client.id);
  }

  /**
   * CLI 客户端请求获取项目列表
   */
  @SubscribeMessage('cli:getProjects')
  async handleGetProjects(@ConnectedSocket() client: Socket) {
    this.logger.log(`CLI ${client.id} requested projects`);
    // 后续会由 ProjectService 处理
    return { event: 'cli:projects', data: [] };
  }

  /**
   * CLI 客户端请求获取会话列表
   */
  @SubscribeMessage('cli:getSessions')
  async handleGetSessions(
    @MessageBody() data: { projectId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`CLI ${client.id} requested sessions for project ${data.projectId}`);
    // 后续会由 SessionService 处理
    return { event: 'cli:sessions', data: [] };
  }

  /**
   * CLI 客户端请求劫持会话
   */
  @SubscribeMessage('cli:takeoverSession')
  async handleTakeoverSession(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`CLI ${client.id} requested takeover for session ${data.sessionId}`);
    // 后续会由 TakeoverService 处理
    return { event: 'cli:takeoverResult', data: { success: true } };
  }

  /**
   * 向所有连接的 CLI 客户端广播会话更新
   */
  broadcastSessionUpdate(sessionId: string, data: any) {
    this.server.emit('session:update', { sessionId, data });
  }

  /**
   * 向特定 CLI 客户端发送消息
   */
  sendToClient(clientId: string, event: string, data: any) {
    const client = this.connectedClients.get(clientId);
    if (client) {
      client.emit(event, data);
    }
  }

  /**
   * 模块销毁时的清理逻辑 - 解决热重启端口占用问题
   */
  async onModuleDestroy() {
    this.logger.log('🧹 [清理] 开始 WebSocket 清理...');

    try {
      if (!this.server) {
        this.logger.warn('⚠️ Socket.IO Server 未初始化，跳过清理');
        return;
      }

      // 1. 通知所有客户端服务器即将关闭
      this.server.emit('server-shutdown', {
        message: 'Server is shutting down',
        timestamp: Date.now(),
      });

      // 2. 等待 100ms 让消息发送出去
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 3. 断开所有客户端连接
      const sockets = await this.server.fetchSockets();
      for (const socket of sockets) {
        socket.disconnect(true);
      }
      this.logger.log(`🔌 已断开 ${sockets.length} 个客户端连接`);

      // 4. 清理客户端记录
      this.connectedClients.clear();

      // 5. 关闭 Socket.IO Server
      await new Promise<void>((resolve, reject) => {
        this.server.close((err) => {
          if (err) {
            this.logger.error('❌ 关闭 Socket.IO Server 失败:', err);
            reject(err);
          } else {
            this.logger.log('✅ Socket.IO Server 已关闭 (端口 10007 已释放)');
            resolve();
          }
        });
      });

    } catch (error) {
      this.logger.error('❌ WebSocket 清理过程中出错:', error);
      throw error;
    }
  }
}
