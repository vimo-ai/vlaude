/**
 * @description main module of the project
 * @author 阿怪
 * @date 2025/2/7 16:14
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */

import { Module } from '@nestjs/common';
import { HealthController } from './common/controllers/health.controller';
import { VersionController } from './common/controllers/version.controller';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';
import { DaemonGatewayModule } from './module/daemon-gateway/daemon-gateway.module';
import { ProjectModule } from './module/project/project.module';
import { SessionModule } from './module/session/session.module';
import { GatewayModule } from './gateway/gateway.module';
import { AuthModule } from './auth/auth.module';
import { DeviceModule } from './device/device.module';
import { RegistryModule } from './module/registry/registry.module';
import { StatusModule } from './module/status';
import { DataSyncModule } from './module/data-sync';
// @feature:minio:start
// import { MinioModule } from './module/minio/minio.module';
// @feature:minio:end

@Module({
  imports: [
    // V4: 移除 SharedDbModule，数据源改为 Daemon 代理
    // V5 (Phase 3): 添加 DataSyncModule 支持可选的数据同步模式
    CacheModule.register({ isGlobal: true }),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', 'env/.env.dev', 'env/.env.local', 'env/.env.nas', 'env/.env.prod', 'env/.env'],
    }),
    DataSyncModule,
    // Vlaude 核心模块
    GatewayModule,
    DaemonGatewayModule,
    ProjectModule,
    SessionModule,
    AuthModule,
    DeviceModule,
    RegistryModule,
    StatusModule.register(),
    // @feature:minio:start
    // MinioModule,
    // @feature:minio:end
  ],
  controllers: [HealthController, VersionController],
})
export class AppModule {}
