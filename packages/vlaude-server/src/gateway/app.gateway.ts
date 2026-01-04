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
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

import { ConfigService } from '@nestjs/config';
import { DeviceService } from '../device/device.service';
import { DaemonGateway } from '../module/daemon-gateway/daemon.gateway';
import { RegistryService } from '../module/registry/registry.service';
import * as jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { join } from 'path';

// 资源类型枚举（与 Daemon 端保持一致）
enum ResourceType {
  PROJECT = 'project',
  SESSION = 'session',
}

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
export class AppGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AppGateway.name);

  // JWT 认证相关
  private readonly jwtPublicKey: string;
  private readonly ipWhitelist: string[];

  // 会话订阅管理：sessionId -> { subscribers: Set<clientId>, projectPath: string }
  private sessionSubscriptions = new Map<string, { subscribers: Set<string>; projectPath: string }>();

  // 客户端管理：clientId -> ClientInfo
  private clients = new Map<string, ClientInfo>();

  // Session 的客户端类型管理：sessionId -> { cli: clientId | null, swift: Set<clientId> }
  private sessionClients = new Map<string, { cli: string | null; swift: Set<string> }>();

  // UUID 匹配状态管理（用于双重确认 sessionId）
  // projectPath -> { uuids: Set<uuid>, sessionIds: Set<sessionId>, clientId: string }
  private uuidMatching = new Map<string, {
    uuids: Set<string>;           // CLI 报告的 UUID
    sessionIds: Set<string>;      // Daemon 检测到的 sessionId
    clientId: string;             // CLI 的 clientId
  }>();

  // Daemon 服务地址 (从环境变量读取)
  private readonly DAEMON_URL: string;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly deviceService: DeviceService,
    @Inject(forwardRef(() => DaemonGateway))
    private readonly daemonGateway: DaemonGateway,
    @Inject(forwardRef(() => RegistryService))
    private readonly registryService: RegistryService,
  ) {
    // 初始化 Daemon URL
    const daemonHost = this.configService.get<string>('DAEMON_HOST', 'localhost');
    const daemonPort = this.configService.get<number>('DAEMON_PORT', 10006);
    this.DAEMON_URL = `http://${daemonHost}:${daemonPort}`;

    // 加载 JWT 公钥
    const publicKeyPath = this.configService.get<string>('JWT_PUBLIC_KEY_PATH');
    if (publicKeyPath) {
      try {
        this.jwtPublicKey = readFileSync(join(process.cwd(), publicKeyPath), 'utf-8');
        this.logger.log(`✅ JWT 公钥已加载`);
      } catch (error) {
        this.logger.error(`❌ 无法加载 JWT 公钥: ${error.message}`);
        throw error;
      }
    } else {
      this.logger.warn('⚠️ JWT_PUBLIC_KEY_PATH 未配置，WebSocket 将不使用 JWT 认证');
      this.jwtPublicKey = null;
    }

    // 解析 IP 白名单
    const ipWhitelistConfig = this.configService.get<string>('IP_WHITELIST', '');
    this.ipWhitelist = ipWhitelistConfig
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);

    if (this.ipWhitelist.length > 0) {
      this.logger.log(`✅ IP 白名单: ${this.ipWhitelist.join(', ')}`);
    }
  }

  /**
   * 初始化 WebSocket 中间件（JWT 认证）
   */
  afterInit(server: Server) {
    // 如果没有配置 JWT，跳过认证
    if (!this.jwtPublicKey) {
      this.logger.warn('⚠️ JWT 认证未启用');
      return;
    }

    this.logger.log('🔒 [JWT] 注册 WebSocket 认证中间件');

    server.use(async (socket: Socket, next) => {
      // 1. 获取客户端 IP
      const clientIp = this.getClientIp(socket);

      // 2. 检查 IP 白名单
      if (this.isWhitelistedIp(clientIp)) {
        this.logger.log(`🔓 [JWT] 内网 IP ${clientIp} 豁免认证`);
        socket.data.user = { clientId: 'internal', clientType: 'daemon' };
        return next();
      }

      // 3. 外网必须验证 Token
      const token = socket.handshake.auth?.token || (socket.handshake.query?.token as string);

      if (!token) {
        this.logger.warn(`❌ [JWT] 连接缺少 Token: ${socket.id} (IP: ${clientIp})`);
        return next(new Error('Authentication error: missing token'));
      }

      try {
        const payload = jwt.verify(token, this.jwtPublicKey, {
          algorithms: ['RS256'],
        }) as any;

        // 检查设备白名单
        const deviceId = payload.deviceId || payload.clientId; // 向后兼容：如果没有 deviceId，使用 clientId

        if (deviceId) {
          const isDeviceValid = await this.deviceService.verifyDevice(deviceId);

          if (!isDeviceValid) {
            this.logger.error(
              `❌ [设备验证] 设备未注册或已撤销: ${deviceId} (socket: ${socket.id})`,
            );
            return next(new Error('Authentication error: device not registered or revoked'));
          }

          // 更新设备最后登录时间
          await this.deviceService.updateLastLogin(deviceId);
          this.logger.log(
            `✅ [JWT+设备] 认证成功: ${socket.id} (deviceId=${deviceId}, deviceName=${payload.deviceName || 'N/A'})`,
          );
        } else {
          this.logger.warn(
            `⚠️ [JWT] Token 中缺少 deviceId: ${socket.id} (旧版本 Token，允许连接)`,
          );
        }

        socket.data.user = payload;
        next();
      } catch (error) {
        this.logger.error(`❌ [JWT] 认证失败: ${socket.id} - ${error.message}`);
        return next(new Error('Authentication error: invalid token'));
      }
    });
  }

  handleConnection(client: Socket) {
    const user = client.data.user;
    this.logger.log(`✅ 客户端连接: ${client.id} (${user?.clientId || 'unknown'})`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`❌ 客户端断开: ${client.id}`);
    this.cleanupClient(client.id);
  }

  /**
   * 从 Socket 提取客户端 IP
   */
  private getClientIp(socket: Socket): string {
    const handshake = socket.handshake;

    // 优先从 X-Forwarded-For 获取（反向代理场景）
    const forwardedFor = handshake.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
      return ip.split(',')[0].trim();
    }

    // X-Real-IP
    const realIp = handshake.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }

    // 直连场景
    return handshake.address || 'unknown';
  }

  /**
   * 检查 IP 是否在白名单中
   */
  private isWhitelistedIp(ip: string): boolean {
    if (!ip || ip === 'unknown') return false;

    // 精确匹配
    if (this.ipWhitelist.includes(ip)) return true;

    // CIDR 匹配
    return this.ipWhitelist.some((cidr) => this.ipInCidr(ip, cidr));
  }

  /**
   * 检查 IP 是否在 CIDR 范围内
   */
  private ipInCidr(ip: string, cidr: string): boolean {
    // 如果不是 CIDR 格式，直接比较
    if (!cidr.includes('/')) return ip === cidr;

    const [subnet, bits] = cidr.split('/');
    const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1);
    const ipNum = this.ipToNumber(ip);
    const subnetNum = this.ipToNumber(subnet);

    return (ipNum & mask) === (subnetNum & mask);
  }

  /**
   * 将 IP 地址转换为数字
   */
  private ipToNumber(ip: string): number {
    return (
      ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
    );
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
   * CLI 请求退出 Remote 模式
   */
  @SubscribeMessage('cli:requestExitRemote')
  async handleCliRequestExitRemote(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId } = data;
    this.logger.log(`📱 [CLI 请求退出Remote] Session: ${sessionId}`);

    // 获取 session 的 projectPath
    const clientInfo = this.clients.get(client.id);
    if (!clientInfo || !clientInfo.projectPath) {
      this.logger.warn(`⚠️ 无法找到客户端信息或 projectPath: ${client.id}`);
      client.emit('server:exitRemoteAllowed', { sessionId });
      return { success: false, message: '无法找到项目路径' };
    }

    const { projectPath } = clientInfo;

    try {
      // 询问 Daemon：session 是否在 loading？
      const response = await firstValueFrom(
        this.httpService.post(`${this.DAEMON_URL}/sessions/check-loading`, {
          sessionId,
          projectPath,
        }),
      );

      const loading = response.data?.loading || false;

      if (loading) {
        // 正在 loading，拒绝退出
        this.logger.log(`⏸️ [拒绝退出] Session ${sessionId} 正在 loading`);
        client.emit('server:exitRemoteDenied', {
          sessionId,
          reason: 'loading',
        });
      } else {
        // 空闲，允许退出
        this.logger.log(`✅ [允许退出] Session ${sessionId} 空闲`);
        client.emit('server:exitRemoteAllowed', { sessionId });
      }

      return { success: true, loading };
    } catch (error) {
      this.logger.error(`❌ [检查Loading失败] ${error.message}`);
      // 出错时默认允许退出
      client.emit('server:exitRemoteAllowed', { sessionId });
      return { success: false, message: error.message };
    }
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
        client.emit('remote-connect', { sessionId });
      }
    } else if (clientType === 'swift') {
      // Swift 客户端加入
      sessionClientInfo.swift.add(client.id);

      // 通知 CLI 客户端有 Swift 接管
      if (sessionClientInfo.cli) {
        this.logger.log(`📱 [Join] Swift 客户端加入，通知 CLI: ${sessionClientInfo.cli}`);
        this.server.to(sessionClientInfo.cli).emit('remote-connect', { sessionId });
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
   * CLI 报告检测到的 UUID（通过 Monkey Patch fd 3）
   */
  @SubscribeMessage('cli:reportUUID')
  handleCliReportUUID(
    @MessageBody() data: { uuid: string; projectPath: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { uuid, projectPath } = data;

    this.logger.log(`🔑 [UUID 报告] CLI ${client.id} 报告 UUID: ${uuid.substring(0, 8)}...`);
    this.logger.log(`   项目路径: ${projectPath}`);

    // 初始化或获取匹配状态
    if (!this.uuidMatching.has(projectPath)) {
      this.uuidMatching.set(projectPath, {
        uuids: new Set(),
        sessionIds: new Set(),
        clientId: client.id,
      });
    }

    const matchState = this.uuidMatching.get(projectPath)!;
    matchState.uuids.add(uuid);

    // 尝试匹配
    this.tryMatchSession(projectPath);

    return { success: true };
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

    // 初始化 UUID 匹配状态
    if (!this.uuidMatching.has(projectPath)) {
      this.uuidMatching.set(projectPath, {
        uuids: new Set(),
        sessionIds: new Set(),
        clientId: client.id,
      });
    }

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

      // 如果 session 在 ETerm 中，通知 ETerm 有 Mobile 正在查看
      const inEterm = await this.daemonGateway.isSessionInEterm(sessionId);
      if (inEterm) {
        this.logger.log(`📱 [ETerm] 通知 Mobile 正在查看 session ${sessionId}`);
        await this.daemonGateway.notifyEtermMobileViewing(sessionId, true);
      }
    }

    return { success: true, message: `已订阅会话 ${sessionId}` };
  }

  /**
   * 客户端取消订阅
   * 注意：现在从 Redis 读取状态，已改为 async
   */
  @SubscribeMessage('session:unsubscribe')
  async handleSessionUnsubscribe(
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

        // 如果 session 在 ETerm 中，通知 ETerm 没有 Mobile 在查看了
        const inEterm = await this.daemonGateway.isSessionInEterm(sessionId);
        if (inEterm) {
          this.logger.log(`📱 [ETerm] 通知 Mobile 离开了 session ${sessionId}`);
          await this.daemonGateway.notifyEtermMobileViewing(sessionId, false);
        }
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

    // 检查 session 是否在 ETerm 中
    const inEterm = await this.daemonGateway.isSessionInEterm(sessionId);
    if (inEterm) {
      this.logger.log(`🖥️ [ETerm 注入] Session ${sessionId} 在 ETerm 中，使用注入方式`);

      const injected = await this.daemonGateway.injectMessageToEterm(sessionId, text);

      if (injected) {
        this.logger.log(`✅ [ETerm 注入] 消息已发送到 ETerm`);
        return { success: true, via: 'eterm' };
      } else {
        this.logger.warn(`⚠️ [ETerm 注入] 注入失败，回退到 SDK`);
        // 回退到 SDK 方式（继续执行下面的代码）
      }
    }

    try {
      // V2: 只传递 projectPath，Daemon 内部查表
      // V3: 添加 clientId 用于权限请求
      const response = await firstValueFrom(
        this.httpService.post(`${this.DAEMON_URL}/sessions/send-message`, {
          sessionId,
          text,
          projectPath: clientInfo.projectPath,
          clientId: client.id,  // 添加 iOS 客户端 ID
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
   * 推送 Metrics 更新到订阅了该会话的客户端
   */
  notifyMetricsUpdate(sessionId: string, metrics: any) {
    const subscription = this.sessionSubscriptions.get(sessionId);

    if (subscription && subscription.subscribers.size > 0) {
      subscription.subscribers.forEach((clientId) => {
        this.server.to(clientId).emit('statusline:metricsUpdate', {
          sessionId,
          ...metrics,
        });
      });
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
   * 通用资源更新推送（v3.0 统一架构）
   */
  private notifyResourceUpdate<T = any>(
    type: ResourceType,
    id: string,
    metadata?: T,
  ) {
    const eventName = `${type}:updated`;
    const idField = this.getIdFieldName(type);

    this.server.emit(eventName, {
      [idField]: id,
      metadata,
    });

    this.logger.log(`🔄 广播 ${type} 更新: ${id}`);
  }

  /**
   * 获取 ID 字段名（向后兼容）
   */
  private getIdFieldName(type: ResourceType): string {
    switch (type) {
      case ResourceType.PROJECT:
        return 'projectPath';
      case ResourceType.SESSION:
        return 'sessionId';
      default:
        return 'id';
    }
  }

  /**
   * Daemon 调用：广播项目更新
   */
  notifyProjectUpdate(projectPath: string, metadata?: any) {
    this.notifyResourceUpdate(ResourceType.PROJECT, projectPath, metadata);
  }

  /**
   * Daemon 调用：广播会话元数据更新
   */
  notifySessionUpdate(sessionId: string, metadata: any) {
    this.notifyResourceUpdate(ResourceType.SESSION, sessionId, metadata);
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
    this.logger.log(`📥 [事件监听] 收到新Session创建事件: ${data.sessionId.substring(0, 8)}...`);
    this.logger.log(`   项目路径: ${data.projectPath}`);

    // 获取或初始化匹配状态
    if (!this.uuidMatching.has(data.projectPath)) {
      this.uuidMatching.set(data.projectPath, {
        uuids: new Set(),
        sessionIds: new Set(),
        clientId: data.clientId,
      });
    }

    const matchState = this.uuidMatching.get(data.projectPath)!;
    matchState.sessionIds.add(data.sessionId);

    // 尝试匹配
    this.tryMatchSession(data.projectPath);
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
   * 监听来自 DaemonGateway 的 Metrics 更新事件
   */
  @OnEvent('app.notifyMetricsUpdate')
  handleNotifyMetricsUpdateEvent(data: { sessionId: string; metrics: any }) {
    this.notifyMetricsUpdate(data.sessionId, data.metrics);
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

  /**
   * 监听来自 DaemonGateway 的会话列表更新事件
   */
  @OnEvent('app.notifySessionListUpdate')
  handleNotifySessionListUpdateEvent(data: { projectPath: string }) {
    this.logger.log(`📥 [事件监听] 收到会话列表更新事件: ${data.projectPath}`);
    this.notifySessionListUpdate(data.projectPath);
  }

  /**
   * 通知所有客户端会话列表已更新
   */
  notifySessionListUpdate(projectPath: string) {
    this.server.emit('session:listUpdate', { projectPath });
    this.logger.log(`📤 [广播] session:listUpdate for ${projectPath}`);
  }

  // =================== ETerm 状态变化 ===================

  /**
   * 监听来自 DaemonGateway 的 ETerm 状态变化事件
   */
  @OnEvent('app.etermStatusChanged')
  handleEtermStatusChangedEvent(data: { online: boolean; timestamp: string }) {
    this.logger.log(`🖥️ [ETerm 状态] ${data.online ? '上线' : '离线'} at ${data.timestamp}`);

    // 广播给所有连接的客户端
    this.server.emit('eterm:statusChanged', {
      online: data.online,
      timestamp: data.timestamp,
    });
  }

  /**
   * 监听来自 DaemonGateway 的 ETerm Session 可用事件
   */
  @OnEvent('app.etermSessionAvailable')
  handleEtermSessionAvailableEvent(data: { sessionId: string; projectPath: string; timestamp: string }) {
    this.logger.log(`🖥️ [ETerm Session] 可用: ${data.sessionId}`);
    this.logger.log(`   ProjectPath: ${data.projectPath}`);

    // 广播给所有连接的客户端（包含 projectPath 供 iOS 更新计数）
    this.server.emit('eterm:sessionAvailable', {
      sessionId: data.sessionId,
      projectPath: data.projectPath,
      timestamp: data.timestamp,
    });
  }

  /**
   * 监听来自 DaemonGateway 的 ETerm Session 不可用事件
   */
  @OnEvent('app.etermSessionUnavailable')
  handleEtermSessionUnavailableEvent(data: { sessionId: string; projectPath?: string; timestamp: string }) {
    this.logger.log(`🖥️ [ETerm Session] 不可用: ${data.sessionId}`);
    if (data.projectPath) {
      this.logger.log(`   ProjectPath: ${data.projectPath}`);
    }

    // 广播给所有连接的客户端（包含 projectPath 供 iOS 更新计数）
    this.server.emit('eterm:sessionUnavailable', {
      sessionId: data.sessionId,
      projectPath: data.projectPath,
      timestamp: data.timestamp,
    });
  }

  /**
   * 监听来自 DaemonGateway 的 ETerm 会话创建完成事件
   */
  @OnEvent('app.etermSessionCreated')
  handleEtermSessionCreatedEvent(data: { requestId: string; sessionId: string; projectPath: string; timestamp: string }) {
    this.logger.log(`🖥️ [ETerm Session] 创建完成:`);
    this.logger.log(`   RequestId: ${data.requestId}`);
    this.logger.log(`   SessionId: ${data.sessionId}`);
    this.logger.log(`   ProjectPath: ${data.projectPath}`);

    // 广播给所有连接的客户端（iOS 会根据 requestId 匹配）
    this.server.emit('eterm:sessionCreated', {
      requestId: data.requestId,
      sessionId: data.sessionId,
      projectPath: data.projectPath,
      timestamp: data.timestamp,
    });
  }

  /**
   * iOS 主动查询 ETerm 状态（解决时序问题）
   * 当 iOS 连接后，可以调用此事件获取当前 ETerm 状态
   *
   * 返回格式：直接返回对象，NestJS 会作为 ACK 响应发送
   * 客户端使用 emitWithAck 后，响应数组的第一个元素就是这个对象
   *
   * 注意：现在从 Redis 读取状态，已改为 async
   *
   * @see docs/DATA_STRUCTURE_SYNC.md#4-websocket-appqueryetermstatus
   * @see Vlaude/Services/WebSocketManager.swift - iOS 端 WebSocket 处理
   */
  @SubscribeMessage('app:queryEtermStatus')
  async handleQueryEtermStatus(@ConnectedSocket() client: Socket) {
    const online = await this.daemonGateway.isEtermOnline();
    const sessions = await this.daemonGateway.getEtermSessions();
    const sessionCounts = await this.daemonGateway.getEtermSessionCounts();

    this.logger.log(`📱 [ETerm 状态查询] 客户端 ${client.id} 查询 ETerm 状态`);
    this.logger.log(`   Online: ${online}`);
    this.logger.log(`   Sessions: ${sessions.length} 个`);
    this.logger.log(`   SessionCounts: ${JSON.stringify(sessionCounts)}`);

    // 直接返回对象，NestJS 会作为 ACK 响应发送
    // 客户端 emitWithAck 收到的是 [{ online, sessions, sessionCounts, timestamp }]
    // @see docs/DATA_STRUCTURE_SYNC.md#4-websocket-appqueryetermstatus
    return {
      online,
      sessions,           // sessionId 数组（兼容旧版本）
      sessionCounts,      // projectPath -> count 映射（iOS 项目列表使用）
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 尝试匹配 UUID 和 sessionId（双重确认）
   */
  private tryMatchSession(projectPath: string) {
    const matchState = this.uuidMatching.get(projectPath);
    if (!matchState) return;

    const { uuids, sessionIds, clientId } = matchState;

    // 找到匹配的 sessionId（同时在 uuids 和 sessionIds 中）
    for (const sessionId of sessionIds) {
      if (uuids.has(sessionId)) {
        this.logger.log(`✅ [UUID 匹配成功] ${sessionId.substring(0, 8)}...`);
        this.logger.log(`   项目路径: ${projectPath}`);
        this.logger.log(`   CLI: ${clientId}`);

        // 通知 CLI sessionId 已确认
        this.server.to(clientId).emit('server:sessionConfirmed', { sessionId });

        // 清理匹配状态
        this.uuidMatching.delete(projectPath);
        return;
      }
    }

    // 没有匹配，记录当前状态
    this.logger.log(`⏳ [UUID 匹配中] 等待匹配...`);
    this.logger.log(`   项目路径: ${projectPath}`);
    this.logger.log(`   UUID 数量: ${uuids.size}`);
    this.logger.log(`   SessionId 数量: ${sessionIds.size}`);
  }

  // =================== 权限请求相关 ===================

  /**
   * 监听来自 DaemonGateway 的权限请求事件
   */
  @OnEvent('app.sendApprovalRequest')
  handleSendApprovalRequestEvent(data: {
    requestId: string;
    sessionId: string;
    clientId: string;
    toolName: string;
    input: any;
    toolUseID: string;
    description: string;
  }) {
    this.logger.log(`🔐 [权限请求] 转发给 iOS 客户端`);
    this.logger.log(`   RequestId: ${data.requestId}`);
    this.logger.log(`   ClientId: ${data.clientId}`);
    this.logger.log(`   Tool: ${data.toolName}`);

    // 通过 WebSocket 发送给 iOS 客户端
    this.server.to(data.clientId).emit('approval-request', {
      requestId: data.requestId,
      sessionId: data.sessionId,
      toolName: data.toolName,
      input: data.input,
      toolUseID: data.toolUseID,
      description: data.description,
    });
  }

  /**
   * iOS 客户端发送权限响应
   */
  @SubscribeMessage('approval-response')
  handleApprovalResponse(
    @MessageBody() data: { requestId: string; approved: boolean; reason?: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.logger.log(`✅ [权限响应] 收到 iOS 响应`);
    this.logger.log(`   RequestId: ${data.requestId}`);
    this.logger.log(`   Approved: ${data.approved}`);
    this.logger.log(`   ClientId: ${client.id}`);

    // 通过事件转发给 DaemonGateway
    this.eventEmitter.emit('daemon.sendApprovalResponse', data);

    return { success: true };
  }

  /**
   * 监听来自 DaemonGateway 的权限超时事件
   */
  @OnEvent('app.sendApprovalTimeout')
  handleSendApprovalTimeoutEvent(data: {
    requestId: string;
    sessionId: string;
    clientId: string;
  }) {
    this.logger.log(`⏰ [权限超时] 通知 iOS 客户端`);
    this.logger.log(`   RequestId: ${data.requestId}`);
    this.logger.log(`   ClientId: ${data.clientId}`);

    // 通过 WebSocket 发送给 iOS 客户端
    this.server.to(data.clientId).emit('approval-timeout', {
      requestId: data.requestId,
      message: '权限请求已超时',
    });
  }

  /**
   * 监听来自 DaemonGateway 的延迟响应事件
   */
  @OnEvent('app.sendApprovalExpired')
  handleSendApprovalExpiredEvent(data: {
    requestId: string;
    message: string;
  }) {
    this.logger.log(`⚠️ [延迟响应] 通知相关客户端`);
    this.logger.log(`   RequestId: ${data.requestId}`);

    // 广播给所有客户端（因为不知道是哪个客户端发送的延迟响应）
    this.server.emit('approval-expired', {
      requestId: data.requestId,
      message: data.message,
    });
  }

  /**
   * 监听来自 DaemonGateway 的 SDK 错误事件
   */
  @OnEvent('app.sendSDKError')
  handleSendSDKErrorEvent(data: {
    sessionId: string;
    clientId: string;
    error: { type: string; message: string };
  }) {
    this.logger.log(`❌ [SDK 错误] 通知 iOS 客户端`);
    this.logger.log(`   SessionId: ${data.sessionId}`);
    this.logger.log(`   ClientId: ${data.clientId}`);
    this.logger.log(`   Error: ${data.error.message}`);

    // 通过 WebSocket 发送给 iOS 客户端
    this.server.to(data.clientId).emit('sdk-error', {
      sessionId: data.sessionId,
      error: data.error,
    });
  }

  /**
   * 检查是否需要重新进入 Remote 模式
   * 当 Swift 活动时触发，检查 CLI 是否在 local mode
   */
  @OnEvent('app.checkRemoteMode')
  handleCheckRemoteModeEvent(data: { sessionId: string; projectPath: string }) {
    const { sessionId } = data;
    this.logger.log(`🔍 [检查Remote模式] Session: ${sessionId}`);

    // 检查这个 session 是否有 CLI 和 Swift 客户端
    const sessionClientInfo = this.sessionClients.get(sessionId);
    if (!sessionClientInfo) {
      this.logger.log(`   没有客户端信息，跳过`);
      return;
    }

    const { cli, swift } = sessionClientInfo;

    // 如果有 CLI 在线且有 Swift 客户端
    if (cli && swift.size > 0) {
      this.logger.log(`   CLI 在线，Swift 客户端数: ${swift.size}`);
      this.logger.log(`   重新发送 remote-connect 给 CLI`);

      // 重新发送 remote-connect，让 CLI 进入 remote mode
      this.server.to(cli).emit('remote-connect', { sessionId });
    } else {
      this.logger.log(`   CLI: ${cli || 'none'}, Swift: ${swift.size}`);
      this.logger.log(`   不需要触发 remote-connect`);
    }
  }

  // =================== Redis Daemon 状态变化（从 RegistryService 转发）===================

  /**
   * 监听 Daemon 上线事件（来自 Redis Pub/Sub）
   */
  @OnEvent('app.daemonOnline')
  async handleDaemonOnlineEvent(data: { deviceId: string; timestamp: number }) {
    this.logger.log(`🟢 [Daemon 上线] deviceId: ${data.deviceId}`);

    // 获取 Daemon 详细信息
    const daemonInfo = await this.registryService.getDaemon(data.deviceId);

    // 广播给所有连接的客户端
    this.server.emit('daemon:online', {
      deviceId: data.deviceId,
      deviceName: daemonInfo?.deviceName,
      platform: daemonInfo?.platform,
      sessions: daemonInfo?.sessions || [],
      timestamp: data.timestamp,
    });
  }

  /**
   * 监听 Daemon 下线事件（来自 Redis Pub/Sub）
   */
  @OnEvent('app.daemonOffline')
  handleDaemonOfflineEvent(data: { deviceId: string; timestamp: number }) {
    this.logger.log(`🔴 [Daemon 下线] deviceId: ${data.deviceId}`);

    // 广播给所有连接的客户端
    this.server.emit('daemon:offline', {
      deviceId: data.deviceId,
      timestamp: data.timestamp,
    });
  }

  /**
   * 监听 Daemon Session 更新事件（来自 Redis Pub/Sub）
   */
  @OnEvent('app.daemonSessionUpdate')
  async handleDaemonSessionUpdateEvent(data: { deviceId: string; timestamp: number }) {
    this.logger.log(`📝 [Daemon Session 更新] deviceId: ${data.deviceId}`);

    // 获取更新后的 Daemon 信息
    const daemonInfo = await this.registryService.getDaemon(data.deviceId);

    // 广播给所有连接的客户端
    this.server.emit('daemon:sessionUpdate', {
      deviceId: data.deviceId,
      sessions: daemonInfo?.sessions || [],
      timestamp: data.timestamp,
    });
  }

  /**
   * 客户端查询所有在线 Daemon
   */
  @SubscribeMessage('app:queryDaemons')
  async handleQueryDaemons(@ConnectedSocket() client: Socket) {
    this.logger.log(`📱 [Daemon 列表查询] 客户端 ${client.id} 查询 Daemon 列表`);

    const daemons = await this.registryService.getDaemons();

    this.logger.log(`   找到 ${daemons.length} 个在线 Daemon`);

    // 返回 Daemon 列表
    return {
      daemons: daemons.map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        platform: d.platform,
        version: d.version,
        sessions: d.sessions,
        registeredAt: d.registeredAt,
      })),
      timestamp: Date.now(),
    };
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

      // 4. 清理所有订阅和客户端记录
      this.sessionSubscriptions.clear();
      this.clients.clear();
      this.sessionClients.clear();
      this.uuidMatching.clear();

      // 5. 关闭 Socket.IO Server
      await new Promise<void>((resolve, reject) => {
        this.server.close((err) => {
          if (err) {
            this.logger.error('❌ 关闭 Socket.IO Server 失败:', err);
            reject(err);
          } else {
            this.logger.log('✅ Socket.IO Server 已关闭');
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
