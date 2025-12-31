import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceRegistry } from '@vimo-ai/vlaude-shared-core';

/**
 * 服务注册服务
 * 负责将 vlaude-server 注册到 Redis 服务发现中心
 */
@Injectable()
export class RegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegistryService.name);
  private registry: ServiceRegistry | null = null;
  private readonly serverAddress: string;
  private readonly ttl = 60; // 服务注册 TTL（秒）

  constructor(private readonly configService: ConfigService) {
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

      this.logger.log(`✅ 服务注册成功: server@${this.serverAddress}`);
    } catch (error) {
      this.logger.error(`❌ 服务注册失败: ${error.message}`);
      this.logger.warn('服务注册中心不可用，将继续运行但无法被自动发现');

      // 优雅降级：不影响服务启动
      this.registry = null;
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
}
