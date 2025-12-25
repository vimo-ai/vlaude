import {
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, Inject, forwardRef, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { OnEvent } from '@nestjs/event-emitter';
import { ServerClientService } from '../server-client/server-client.service';
import { createServer, Server as HttpServer } from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * ETerm Gateway
 * 接收来自 ETerm (Swift) 的 WebSocket 连接
 *
 * 职责：
 * 1. 管理 ETerm 连接状态
 * 2. 接收 ETerm 上报的 session 可用信息
 * 3. 转发消息注入请求给 ETerm
 *
 * 使用独立端口 10008，避免与 Fastify HTTP Server 冲突
 */
@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class EtermGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EtermGateway.name);

  // 独立的 HTTP 服务器实例
  private httpServer: HttpServer | null = null;
  private readonly wsPort = 10008;

  // 当前连接的 ETerm 客户端（同一时间只有一个 ETerm）
  private etermClient: Socket | null = null;

  // ETerm 上报的 session -> terminalId 映射
  private etermSessions = new Map<string, number>();
  // terminalId -> sessionId 反向映射（用于处理同一 terminal 切换 session）
  private terminalToSession = new Map<number, string>();

  constructor(
    @Inject(forwardRef(() => ServerClientService))
    private readonly serverClient: ServerClientService,
  ) {}

  /**
   * 模块初始化 - 手动创建独立的 Socket.IO 服务器
   */
  async onModuleInit() {
    this.logger.log('🔧 初始化 ETerm Socket.IO 服务器...');

    try {
      // 检查并清理占用端口的旧进程
      await this.checkAndKillOldProcess();

      // 创建独立的 HTTP 服务器
      this.httpServer = createServer();

      // 创建 Socket.IO 服务器并绑定到独立的 HTTP 服务器
      // 使用 /eterm namespace
      this.server = new Server(this.httpServer, {
        cors: {
          origin: '*',
        },
      });

      // 获取 /eterm namespace
      const etermNamespace = this.server.of('/eterm');

      // 绑定连接事件
      etermNamespace.on('connection', (socket: Socket) => {
        this.handleConnection(socket);

        socket.on('disconnect', () => {
          this.handleDisconnect(socket);
        });

        // 绑定业务事件
        socket.on('session:available', (data: { sessionId: string; terminalId: number }) => {
          this.handleSessionAvailable(socket, data);
        });

        socket.on('session:unavailable', (data: { sessionId: string }) => {
          this.handleSessionUnavailable(socket, data);
        });

        // 监听会话创建完成事件（带 requestId）
        socket.on('session:created', (data: { requestId: string; sessionId: string; projectPath: string }) => {
          this.handleSessionCreated(socket, data);
        });
      });

      // 启动 HTTP 服务器
      await this.startServerWithRetry();

    } catch (error) {
      this.logger.error('❌ 初始化 ETerm Socket.IO 服务器失败:', error);
      throw error;
    }
  }

  /**
   * 检查端口占用并杀掉旧进程
   */
  private async checkAndKillOldProcess(): Promise<void> {
    try {
      const { stdout } = await execAsync(`lsof -i :${this.wsPort} -t`);
      const pids = stdout.trim().split('\n').filter(Boolean);

      if (pids.length === 0) {
        this.logger.log('✅ 端口空闲，无需清理');
        return;
      }

      this.logger.warn(`⚠️ 检测到端口 ${this.wsPort} 被 ${pids.length} 个进程占用`);

      for (const pid of pids) {
        try {
          const { stdout: cmdline } = await execAsync(`ps -p ${pid} -o command=`);
          if (cmdline.includes('vlaude-daemon')) {
            this.logger.log(`🔪 杀掉旧的 vlaude-daemon 进程: PID ${pid}`);
            await execAsync(`kill -9 ${pid}`);
          }
        } catch (err) {
          this.logger.warn(`处理进程 ${pid} 失败: ${err.message}`);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500));
      this.logger.log('✅ 端口清理完成');

    } catch (error: any) {
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
            this.logger.log(`✅ ETerm Socket.IO 服务器已启动，监听端口 ${this.wsPort}`);
            resolve();
          }).on('error', (err: Error) => {
            reject(err);
          });
        });
        return;
      } catch (error: any) {
        if (error.code === 'EADDRINUSE' && attempt < maxRetries) {
          this.logger.warn(`⚠️ 端口 ${this.wsPort} 被占用，${retryDelay}ms 后重试 (${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          this.logger.error(`❌ ETerm Socket.IO 服务器启动失败: ${error.message}`);
          throw error;
        }
      }
    }
  }

  /**
   * ETerm 连接时
   */
  handleConnection(client: Socket) {
    this.logger.log(`🖥️ ETerm 已连接: ${client.id}`);
    this.etermClient = client;

    // 通知 server: ETerm 在线
    this.serverClient.notifyEtermOnline().catch(err => {
      this.logger.error(`通知 server ETerm 在线失败: ${err.message}`);
    });

    // 发送确认
    client.emit('ack', { status: 'ok', message: 'Connected to daemon' });
  }

  /**
   * ETerm 断开时
   */
  handleDisconnect(client: Socket) {
    if (this.etermClient?.id === client.id) {
      this.logger.log(`🖥️ ETerm 已断开: ${client.id}`);
      this.etermClient = null;
      this.etermSessions.clear();
      this.terminalToSession.clear();

      // 通知 server: ETerm 离线
      this.serverClient.notifyEtermOffline().catch(err => {
        this.logger.error(`通知 server ETerm 离线失败: ${err.message}`);
      });
    }
  }

  /**
   * ETerm 上报: session 可用（Terminal 中运行了 Claude，已建立映射）
   *
   * 处理场景：同一个 terminal 切换 session（比如 claude -r 交互式恢复会 fork 新 session）
   */
  handleSessionAvailable(
    client: Socket,
    data: { sessionId: string; terminalId: number },
  ) {
    const { sessionId, terminalId } = data;

    // 检查该 terminal 之前是否有其他 session
    const oldSessionId = this.terminalToSession.get(terminalId);
    if (oldSessionId && oldSessionId !== sessionId) {
      this.logger.log(`🔄 Terminal ${terminalId} 切换 session: ${oldSessionId.slice(0, 8)}... -> ${sessionId.slice(0, 8)}...`);

      // 移除旧 session 的映射
      this.etermSessions.delete(oldSessionId);

      // 通知 server: 旧 session 不再可用
      this.serverClient.notifyEtermSessionUnavailable(oldSessionId).catch(err => {
        this.logger.error(`通知 server 旧 session 不可用失败: ${err.message}`);
      });
    }

    this.logger.log(`📍 Session 可用: ${sessionId.slice(0, 8)}... -> Terminal ${terminalId}`);

    // 记录双向映射
    this.etermSessions.set(sessionId, terminalId);
    this.terminalToSession.set(terminalId, sessionId);

    // 通知 server: 这个 session 在 ETerm 中可用
    this.serverClient.notifyEtermSessionAvailable(sessionId).catch(err => {
      this.logger.error(`通知 server session 可用失败: ${err.message}`);
    });

    return { status: 'ok' };
  }

  /**
   * ETerm 上报: session 不再可用（Terminal 关闭或 Claude 退出）
   */
  handleSessionUnavailable(
    client: Socket,
    data: { sessionId: string },
  ) {
    const { sessionId } = data;
    this.logger.log(`📍 Session 不再可用: ${sessionId}`);

    // 清理双向映射
    const terminalId = this.etermSessions.get(sessionId);
    this.etermSessions.delete(sessionId);
    if (terminalId !== undefined) {
      this.terminalToSession.delete(terminalId);
    }

    // 通知 server
    this.serverClient.notifyEtermSessionUnavailable(sessionId).catch(err => {
      this.logger.error(`通知 server session 不可用失败: ${err.message}`);
    });

    return { status: 'ok' };
  }

  // =================== 供其他模块调用的方法 ===================

  /**
   * 检查 ETerm 是否在线
   */
  isEtermOnline(): boolean {
    return this.etermClient !== null && this.etermClient.connected;
  }

  /**
   * 检查指定 session 是否在 ETerm 中可用
   */
  isSessionInEterm(sessionId: string): boolean {
    return this.etermSessions.has(sessionId);
  }

  /**
   * 获取 session 对应的 terminalId
   */
  getTerminalId(sessionId: string): number | undefined {
    return this.etermSessions.get(sessionId);
  }

  /**
   * 向 ETerm 注入消息（让 ETerm 写入到对应 Terminal）
   * @returns 是否成功发送
   */
  injectMessage(sessionId: string, text: string): boolean {
    if (!this.etermClient) {
      this.logger.warn('❌ ETerm 未连接，无法注入消息');
      return false;
    }

    if (!this.etermSessions.has(sessionId)) {
      this.logger.warn(`❌ Session ${sessionId} 不在 ETerm 中`);
      return false;
    }

    const terminalId = this.etermSessions.get(sessionId);
    this.logger.log(`💉 向 ETerm 注入消息: session=${sessionId}, terminal=${terminalId}`);

    this.etermClient.emit('session:inject', {
      sessionId,
      terminalId,
      text,
    });

    return true;
  }

  /**
   * 通知 ETerm: Mobile 正在查看某个 session
   */
  notifyMobileViewing(sessionId: string, isViewing: boolean): boolean {
    if (!this.etermClient) {
      return false;
    }

    this.etermClient.emit('mobile:viewing', {
      sessionId,
      isViewing,
    });

    this.logger.log(`📱 通知 ETerm: Mobile ${isViewing ? '正在查看' : '离开了'} session ${sessionId}`);
    return true;
  }

  /**
   * 获取所有在 ETerm 中的 session
   */
  getEtermSessions(): string[] {
    return Array.from(this.etermSessions.keys());
  }

  // =================== 事件监听（来自 ServerClientService）===================

  /**
   * 监听来自 Server 的消息注入请求
   */
  @OnEvent('eterm.inject')
  handleInjectEvent(data: { sessionId: string; text: string }) {
    this.logger.log(`📥 [事件] 收到注入请求: session=${data.sessionId}`);
    this.injectMessage(data.sessionId, data.text);
  }

  /**
   * 监听来自 Server 的 Mobile 查看状态通知
   */
  @OnEvent('eterm.mobileViewing')
  handleMobileViewingEvent(data: { sessionId: string; isViewing: boolean }) {
    this.logger.log(`📥 [事件] Mobile ${data.isViewing ? '正在查看' : '离开了'} session ${data.sessionId}`);
    this.notifyMobileViewing(data.sessionId, data.isViewing);
  }

  /**
   * 监听来自 Server 的创建会话请求
   */
  @OnEvent('eterm.createSession')
  handleCreateSessionEvent(data: { projectPath: string; prompt?: string; requestId?: string }) {
    this.logger.log(`📥 [事件] 创建会话请求: projectPath=${data.projectPath}, requestId=${data.requestId || 'N/A'}`);
    this.createClaudeSession(data.projectPath, data.prompt, data.requestId);
  }

  /**
   * 请求 ETerm 创建新的 Claude 会话
   * @param projectPath 项目路径
   * @param prompt 可选的初始提示词
   * @param requestId 可选的请求ID，用于跟踪会话创建
   * @returns 是否成功发送请求
   */
  createClaudeSession(projectPath: string, prompt?: string, requestId?: string): boolean {
    if (!this.etermClient) {
      this.logger.warn('❌ ETerm 未连接，无法创建会话');
      return false;
    }

    this.logger.log(`🖥️ 向 ETerm 发送创建会话请求: projectPath=${projectPath}, requestId=${requestId || 'N/A'}`);

    this.etermClient.emit('session:create', {
      projectPath,
      prompt,
      requestId,  // 透传 requestId
    });

    return true;
  }

  /**
   * 监听来自 ETerm 的会话创建完成事件
   * （在 onModuleInit 的事件绑定中添加）
   */
  handleSessionCreated(client: Socket, data: { requestId: string; sessionId: string; projectPath: string }) {
    const { requestId, sessionId, projectPath } = data;

    this.logger.log(`✅ Session 创建完成:`);
    this.logger.log(`   RequestId: ${requestId}`);
    this.logger.log(`   SessionId: ${sessionId}`);
    this.logger.log(`   ProjectPath: ${projectPath}`);

    // 通知 Server: ETerm 会话创建完成（带 requestId）
    this.serverClient.notifyEtermSessionCreated(requestId, sessionId, projectPath).catch(err => {
      this.logger.error(`通知 server session 创建完成失败: ${err.message}`);
    });

    return { status: 'ok' };
  }

  /**
   * 模块销毁时的清理逻辑
   */
  async onModuleDestroy() {
    this.logger.log('🧹 [清理] 开始 ETerm WebSocket 清理...');

    try {
      if (!this.server || !this.httpServer) {
        return;
      }

      // 断开 ETerm 客户端
      if (this.etermClient) {
        this.etermClient.disconnect(true);
        this.etermClient = null;
      }

      this.etermSessions.clear();

      // 关闭 Socket.IO Server
      await new Promise<void>((resolve) => {
        this.server.close(() => {
          this.logger.log('✅ ETerm Socket.IO Server 已关闭');
          resolve();
        });
        setTimeout(() => resolve(), 500);
      });

      // 关闭 HTTP Server
      if (this.httpServer.listening) {
        await new Promise<void>((resolve) => {
          this.httpServer!.close(() => {
            this.logger.log(`✅ ETerm HTTP Server 已关闭 (端口 ${this.wsPort} 已释放)`);
            resolve();
          });
          setTimeout(() => resolve(), 500);
        });
      }

      this.httpServer = null;
      this.logger.log('✅ ETerm WebSocket 清理完成');

    } catch (error) {
      this.logger.error('❌ ETerm WebSocket 清理过程中出错:', error);
    }
  }
}
