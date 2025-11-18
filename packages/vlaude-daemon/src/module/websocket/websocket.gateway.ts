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
import { Logger } from '@nestjs/common';

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
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
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
}
