import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ServiceRegistry, ServiceEvent, DaemonInfo } from '@vimo-ai/vlaude-shared-core';

/**
 * 服务注册服务
 * 负责将 vlaude-server 注册到 Redis 服务发现中心
 * 并监听 daemon 状态变化，转发给 AppGateway
 */
@Injectable()
export class RegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegistryService.name);
  private registry: ServiceRegistry | null = null;
  private readonly serverAddress: string;
  private readonly ttl = 60; // 服务注册 TTL（秒）

  // 事件回调引用（用于取消订阅）
  private eventCallback: ((event: ServiceEvent) => void) | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    // 从环境变量获取 Server 地址（默认 localhost:10005）
    this.serverAddress = this.configService.get<string>('SERVER_ADDRESS') || 'localhost:10005';
  }

  async onModuleInit() {
    await this.initRegistry();
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
      const redisHost = this.configService.get<string>('REDIS_HOST') || 'localhost';
      const redisPort = this.configService.get<number>('REDIS_PORT') || 6379;
      const redisPassword = this.configService.get<string>('REDIS_PASSWORD');

      this.logger.log(`初始化服务注册中心 (Redis: ${redisHost}:${redisPort})`);

      // 创建 ServiceRegistry 实例
      this.registry = new ServiceRegistry({
        host: redisHost,
        port: redisPort,
        password: redisPassword,
        keyPrefix: 'vlaude:',
      });

      // 注册服务
      await this.registry.register('server', this.serverAddress, this.ttl);

      // 启动自动续期（每 30 秒）
      this.registry.startKeepAlive('server', this.serverAddress, this.ttl, 30000);

      // 订阅服务注册事件（监听 daemon 上下线）
      await this.subscribeToServiceEvents();

      this.logger.log(`✅ 服务注册成功: server@${this.serverAddress}`);
    } catch (error) {
      this.logger.error(`❌ 服务注册失败: ${error.message}`);
      this.logger.warn('服务注册中心不可用，将继续运行但无法被自动发现');

      // 优雅降级：不影响服务启动
      this.registry = null;
    }
  }

  /**
   * 订阅服务注册事件
   */
  private async subscribeToServiceEvents() {
    if (!this.registry) return;

    this.eventCallback = (event: ServiceEvent) => {
      this.handleServiceEvent(event);
    };

    await this.registry.subscribe(this.eventCallback);
    this.logger.log('✅ 已订阅服务注册事件');
  }

  /**
   * 处理服务注册事件
   */
  private handleServiceEvent(event: ServiceEvent) {
    this.logger.log(`📥 [Registry Event] ${event.type}: ${event.service}@${event.address}`);

    // 只处理 daemon 相关事件
    if (event.service === 'daemon') {
      if (event.type === 'online') {
        // Daemon 上线：通知 AppGateway 广播给所有客户端
        this.eventEmitter.emit('app.daemonOnline', {
          deviceId: event.address,  // address 存储的是 deviceId
          timestamp: event.timestamp,
        });
      } else if (event.type === 'offline') {
        // Daemon 下线：通知 AppGateway 广播给所有客户端
        this.eventEmitter.emit('app.daemonOffline', {
          deviceId: event.address,
          timestamp: event.timestamp,
        });
      } else if (event.type === 'session_update') {
        // Session 更新：通知 AppGateway 广播给所有客户端
        this.eventEmitter.emit('app.daemonSessionUpdate', {
          deviceId: event.address,
          timestamp: event.timestamp,
        });
      }
    }
  }

  /**
   * 清理资源
   */
  private async cleanup() {
    if (!this.registry) {
      return;
    }

    try {
      // 取消事件订阅
      if (this.eventCallback) {
        await this.registry.unsubscribe(this.eventCallback);
        this.eventCallback = null;
      }

      // 停止自动续期
      this.registry.stopKeepAlive('server', this.serverAddress);

      // 注销服务
      await this.registry.unregister('server', this.serverAddress);

      // 断开 Redis 连接
      await this.registry.disconnect();

      this.logger.log('✅ 服务注销成功');
    } catch (error) {
      this.logger.error(`❌ 服务注销失败: ${error.message}`);
    }
  }

  /**
   * 获取 Registry 实例（供其他服务使用）
   */
  getRegistry(): ServiceRegistry | null {
    return this.registry;
  }

  /**
   * 获取所有在线 Daemon
   */
  async getDaemons(): Promise<DaemonInfo[]> {
    if (!this.registry) {
      return [];
    }
    return this.registry.getDaemons();
  }

  /**
   * 获取指定 Daemon 信息
   */
  async getDaemon(deviceId: string): Promise<DaemonInfo | null> {
    if (!this.registry) {
      return null;
    }
    return this.registry.getDaemon(deviceId);
  }
}
