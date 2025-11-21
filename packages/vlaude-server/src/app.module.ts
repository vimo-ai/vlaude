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
import { PrismaModule } from './shared/database/prisma.module';
import { GatewayModule } from './gateway/gateway.module';
import { AuthModule } from './auth/auth.module';
// @feature:minio:start
// import { MinioModule } from './module/minio/minio.module';
// @feature:minio:end

@Module({
  imports: [
    PrismaModule.forRoot(),
    CacheModule.register({ isGlobal: true }),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['env/.env.dev', 'env/.env.local', 'env/.env.nas', 'env/.env.prod', 'env/.env'],
    }),
    // Vlaude 核心模块
    GatewayModule,
    DaemonGatewayModule,
    ProjectModule,
    SessionModule,
    AuthModule,
    // @feature:minio:start
    // MinioModule,
    // @feature:minio:end
  ],
  controllers: [HealthController, VersionController],
})
export class AppModule {}
