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
// @feature:minio:start
// import { MinioModule } from './module/minio/minio.module';
// @feature:minio:end
// @feature:auth:start
// 方案 A：接入第三方/平台 SDK（示例：@vimo/user-sdk）
// import { UserPlatformSdkModule } from '@vimo/user-sdk';
// 方案 B：使用内置占位 AuthModule，后续按需替换为具体实现
// import { AuthModule } from './module/auth/auth.module';
// @feature:auth:end

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
    // @feature:auth:start
    // 选择其一：平台 SDK / 内置占位模块
    // UserPlatformSdkModule.forRootAsync(),
    // AuthModule,
    // @feature:auth:end
    // @feature:minio:start
    // MinioModule,
    // @feature:minio:end
  ],
  controllers: [HealthController, VersionController],
})
export class AppModule {}
