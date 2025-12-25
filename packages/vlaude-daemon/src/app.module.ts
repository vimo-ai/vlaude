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
import { SessionController } from './common/controllers/session.controller';
import { EtermController } from './common/controllers/eterm.controller';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { VlaudeWebSocketModule } from './module/websocket/websocket.module';
import { ServerClientModule } from './module/server-client/server-client.module';
import { ProcessManagerModule } from './module/process-manager/process-manager.module';
import { DataCollectorModule } from './module/data-collector/data-collector.module';
import { FileWatcherModule } from './module/file-watcher/file-watcher.module';
import { WatchModeController } from './common/controllers/watch-mode.controller';
import { ProjectController } from './common/controllers/project.controller';
import { ConfigLoaderModule } from './module/config-loader/config-loader.module';
import { EtermModule } from './module/eterm-gateway/eterm.module';
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
    CacheModule.register({ isGlobal: true }),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['env/.env.dev', 'env/.env.local', 'env/.env.nas', 'env/.env.prod', 'env/.env'],
    }),
    EventEmitterModule.forRoot(),
    // Vlaude 核心模块
    VlaudeWebSocketModule,
    ServerClientModule,
    ProcessManagerModule,
    DataCollectorModule,
    FileWatcherModule,
    ConfigLoaderModule,
    EtermModule,
    // @feature:auth:start
    // 选择其一：平台 SDK / 内置占位模块
    // UserPlatformSdkModule.forRootAsync(),
    // AuthModule,
    // @feature:auth:end
    // @feature:minio:start
    // MinioModule,
    // @feature:minio:end
  ],
  controllers: [HealthController, VersionController, SessionController, WatchModeController, ProjectController, EtermController],
})
export class AppModule {}
