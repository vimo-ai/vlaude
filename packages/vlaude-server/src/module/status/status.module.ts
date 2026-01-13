/**
 * StatusModule - 在线状态管理模块
 * 根据配置动态选择 Redis 或 Memory 实现
 */

import { Module, DynamicModule, Provider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RedisStatusManager,
  MemoryStatusManager,
  IStatusManager,
} from '@vimo-ai/vlaude-shared-core';
import { StatusService, STATUS_MANAGER_TOKEN } from './status.service';

@Module({})
export class StatusModule {
  private static readonly logger = new Logger(StatusModule.name);

  static register(): DynamicModule {
    const statusManagerProvider: Provider = {
      provide: STATUS_MANAGER_TOKEN,
      useFactory: (configService: ConfigService): IStatusManager => {
        const redisHost = configService.get<string>('REDIS_HOST');

        if (redisHost) {
          // Redis 模式
          const redisPort = configService.get<number>('REDIS_PORT', 6379);
          const redisPassword = configService.get<string>('REDIS_PASSWORD');
          const ttl = configService.get<number>('STATUS_TTL', 60);

          StatusModule.logger.log(`🔴 StatusModule: Redis 模式 (${redisHost}:${redisPort})`);

          return new RedisStatusManager({
            host: redisHost,
            port: redisPort,
            password: redisPassword,
            keyPrefix: 'vlaude:status:',
            ttl,
          });
        } else {
          // Memory 模式
          StatusModule.logger.warn('🟡 StatusModule: Memory 模式（仅用于开发）');

          return new MemoryStatusManager();
        }
      },
      inject: [ConfigService],
    };

    return {
      module: StatusModule,
      providers: [statusManagerProvider, StatusService],
      exports: [StatusService, STATUS_MANAGER_TOKEN],
    };
  }
}
