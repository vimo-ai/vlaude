import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createServer, Server as HttpServer } from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * WebSocket Gateway for CLI communication
 * 供 CLI 客户端连接,实现实时通信
 *
 * 采用手动创建独立 HTTP Server 的方式，解决热重启端口占用问题
 */
@WebSocketGateway({
  cors: {
    origin: '*',
  },
  transports: ['websocket'],
})
export class VlaudeWebSocketGateway
  implements OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(VlaudeWebSocketGateway.name);
  private connectedClients = new Map<string, Socket>();

  // 独立的 HTTP 服务器实例
  private httpServer: HttpServer | null = null;
  private readonly wsPort = 10007;

  /**
   * 模块初始化 - 手动创建独立的 Socket.IO 服务器
   */
  async onModuleInit() {
    this.logger.log('🔧 初始化独立 Socket.IO 服务器...');

    try {
      // 0. 检查并清理占用端口的旧进程
      await this.checkAndKillOldProcess();

      // 1. 创建独立的 HTTP 服务器
      this.httpServer = createServer();

      // 2. 创建 Socket.IO 服务器并绑定到独立的 HTTP 服务器
      this.server = new Server(this.httpServer, {
        cors: {
          origin: '*',
        },
        transports: ['websocket'],
      });

      // 3. 手动绑定连接事件
      this.server.on('connection', (socket: Socket) => {
        this.handleConnection(socket);

        socket.on('disconnect', () => {
          this.handleDisconnect(socket);
        });

        // 手动绑定消息事件（因为不再使用装饰器自动绑定）
        socket.on('cli:getProjects', () => {
          this.handleGetProjects(socket);
        });

        socket.on('cli:getSessions', (data: { projectId: string }) => {
          this.handleGetSessions(data, socket);
        });

        socket.on('cli:takeoverSession', (data: { sessionId: string }) => {
          this.handleTakeoverSession(data, socket);
        });
      });

      // 4. 启动 HTTP 服务器监听独立端口（带重试机制）
      await this.startServerWithRetry();

    } catch (error) {
      this.logger.error('❌ 初始化 Socket.IO 服务器失败:', error);
      throw error;
    }
  }

  /**
   * 检查端口占用并杀掉旧进程
   */
  private async checkAndKillOldProcess(): Promise<void> {
    try {
      // 1. 检查端口是否被占用
      const { stdout } = await execAsync(`lsof -i :${this.wsPort} -t`);
      const pids = stdout.trim().split('\n').filter(Boolean);

      if (pids.length === 0) {
        this.logger.log('✅ 端口空闲，无需清理');
        return;
      }

      this.logger.warn(`⚠️ 检测到端口 ${this.wsPort} 被 ${pids.length} 个进程占用`);

      // 2. 杀掉所有占用端口的进程
      for (const pid of pids) {
        try {
          // 检查进程是否是 vlaude-daemon（避免误杀其他进程）
          const { stdout: cmdline } = await execAsync(`ps -p ${pid} -o command=`);

          if (cmdline.includes('vlaude-daemon')) {
            this.logger.log(`🔪 杀掉旧的 vlaude-daemon 进程: PID ${pid}`);
            await execAsync(`kill -9 ${pid}`);
          } else {
            this.logger.warn(`⚠️ 跳过非 vlaude-daemon 进程: PID ${pid} (${cmdline.trim()})`);
          }
        } catch (err) {
          this.logger.warn(`处理进程 ${pid} 失败: ${err.message}`);
        }
      }

      // 3. 等待端口完全释放
      this.logger.log('⏳ 等待端口释放...');
      await new Promise(resolve => setTimeout(resolve, 500));
      this.logger.log('✅ 端口清理完成');

    } catch (error: any) {
      // lsof 返回 exit code 1 表示没有找到占用端口的进程（正常情况）
      if (error.code === 1) {
        this.logger.log('✅ 端口空闲，无需清理');
      } else {
        this.logger.warn(`⚠️ 检查端口占用失败: ${error.message}`);
      }
    }
  }

  /**
   * 启动服务器，如果端口被占用则重试
   */
  private async startServerWithRetry(maxRetries = 5, retryDelay = 1000): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.httpServer!.listen(this.wsPort, '0.0.0.0', () => {
            this.logger.log(`✅ Socket.IO 服务器已启动，监听端口 ${this.wsPort}`);
            resolve();
          }).on('error', (err: Error) => {
            reject(err);
          });
        });
        return; // 成功启动，退出重试循环
      } catch (error: any) {
        if (error.code === 'EADDRINUSE' && attempt < maxRetries) {
          this.logger.warn(`⚠️ 端口 ${this.wsPort} 被占用，${retryDelay}ms 后重试 (${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          this.logger.error(`❌ Socket.IO 服务器启动失败: ${error.message}`);
          throw error;
        }
      }
    }
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
  async handleGetProjects(client: Socket) {
    this.logger.log(`CLI ${client.id} requested projects`);
    // 后续会由 ProjectService 处理
    client.emit('cli:projects', { data: [] });
  }

  /**
   * CLI 客户端请求获取会话列表
   */
  async handleGetSessions(
    data: { projectId: string },
    client: Socket,
  ) {
    this.logger.log(`CLI ${client.id} requested sessions for project ${data.projectId}`);
    // 后续会由 SessionService 处理
    client.emit('cli:sessions', { data: [] });
  }

  /**
   * CLI 客户端请求劫持会话
   */
  async handleTakeoverSession(
    data: { sessionId: string },
    client: Socket,
  ) {
    this.logger.log(`CLI ${client.id} requested takeover for session ${data.sessionId}`);
    // 后续会由 TakeoverService 处理
    client.emit('cli:takeoverResult', { data: { success: true } });
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
      if (!this.server || !this.httpServer) {
        this.logger.warn('⚠️ Socket.IO Server 未初始化，跳过清理');
        return;
      }

      // 1. 通知所有客户端服务器即将关闭
      try {
        this.server.emit('server-shutdown', {
          message: 'Server is shutting down',
          timestamp: Date.now(),
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (err) {
        this.logger.warn('通知客户端失败，继续清理...');
      }

      // 2. 断开所有客户端连接
      try {
        const sockets = await this.server.fetchSockets();
        for (const socket of sockets) {
          socket.disconnect(true);
        }
        this.logger.log(`🔌 已断开 ${sockets.length} 个客户端连接`);
      } catch (err) {
        this.logger.warn('断开客户端失败，继续清理...');
      }

      // 3. 清理客户端记录
      this.connectedClients.clear();

      // 4. 关闭 Socket.IO Server（不抛出异常）
      try {
        await new Promise<void>((resolve) => {
          this.server.close(() => {
            this.logger.log('✅ Socket.IO Server 已关闭');
            resolve();
          });
          // 设置超时，防止卡住
          setTimeout(() => resolve(), 500);
        });
      } catch (err) {
        this.logger.warn('Socket.IO Server 关闭失败，继续清理...');
      }

      // 5. 强制关闭 HTTP Server（释放端口）
      try {
        // 检查 Server 是否在监听
        if (this.httpServer.listening) {
          await new Promise<void>((resolve) => {
            this.httpServer!.close(() => {
              this.logger.log(`✅ HTTP Server 已关闭 (端口 ${this.wsPort} 已释放)`);
              resolve();
            });
            // 设置超时，防止卡住
            setTimeout(() => {
              this.logger.warn('HTTP Server 关闭超时，强制继续');
              resolve();
            }, 500);
          });
        } else {
          this.logger.warn('⚠️ HTTP Server 未在监听状态');
        }

        // 强制销毁所有连接（确保端口释放）
        if (this.httpServer) {
          // @ts-ignore - 访问内部属性强制关闭
          this.httpServer.closeAllConnections?.();
        }
      } catch (err) {
        this.logger.warn(`HTTP Server 关闭失败: ${err.message}，尝试强制清理`);
      }

      // 6. 清空引用
      this.httpServer = null;
      this.logger.log('✅ WebSocket 清理完成');

    } catch (error) {
      this.logger.error('❌ WebSocket 清理过程中出错:', error);
      // 不再抛出异常，确保清理流程完整执行
    }
  }
}
