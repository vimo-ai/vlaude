/**
 * @description
 * @author 阿怪
 * @date 2024/12/4 00:29
 * @version v1.0.0
 *
 * 江湖的业务千篇一律，复杂的代码好几百行。
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './plugins/filter/allExceptionsFilter';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * 自定义 Socket.IO Adapter：调大 maxHttpBufferSize
 * 默认 1MB 不够大会话（3+ turns 可达 2-5MB），调到 4MB 作为安全兜底
 */
class CustomIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: ServerOptions): any {
    return super.createIOServer(port, {
      ...options,
      maxHttpBufferSize: 4 * 1024 * 1024, // 4MB
    });
  }
}

/**
 * 加载 mTLS 证书配置
 */
function loadMTLSConfig() {
  const certsDir = join(process.cwd(), 'certs');
  const caPath = join(certsDir, 'ca.crt');
  const keyPath = join(certsDir, 'server.key');
  const certPath = join(certsDir, 'server.crt');

  // 检查证书文件是否存在
  if (!existsSync(caPath) || !existsSync(keyPath) || !existsSync(certPath)) {
    return null;
  }

  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    ca: readFileSync(caPath),
    requestCert: true,           // 请求客户端证书
    rejectUnauthorized: false,   // 不强制拒绝（在应用层根据 IP 判断）
    minVersion: 'TLSv1.2' as const,  // 最低 TLS 版本
  };
}

async function bootstrap() {
  // 检查是否启用 mTLS
  const enableMTLS = process.env.ENABLE_MTLS === 'true';
  const mtlsConfig = enableMTLS ? loadMTLSConfig() : null;

  if (enableMTLS && !mtlsConfig) {
    console.error('❌ mTLS 已启用但证书文件缺失！请先运行 scripts/generate-certs.sh');
    console.error('   需要的文件: certs/ca.crt, certs/server.key, certs/server.crt');
    process.exit(1);
  }

  const fastifyAdapter = new FastifyAdapter({
    https: mtlsConfig || undefined,
  });
  fastifyAdapter.register(fastifyMultipart , {})

  const app = await NestFactory.create(AppModule, fastifyAdapter);

  // 使用自定义 Socket.IO adapter（maxHttpBufferSize: 4MB）
  app.useWebSocketAdapter(new CustomIoAdapter(app));

  app.enableCors();
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));

  const port = process.env.PORT || 10005;
  await app.listen(port, '0.0.0.0');

  const protocol = mtlsConfig ? 'https' : 'http';
  console.log(`Vlaude Server is running on: ${protocol}://localhost:${port}`);
  if (mtlsConfig) {
    console.log('🔐 mTLS 已启用，需要客户端证书才能访问');
  }

  // 优雅关闭处理 - 解决热重启时端口占用问题
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n⚠️ Received ${signal}, starting graceful shutdown...`);

    try {
      // 停止接收新请求，触发所有模块的 onModuleDestroy 钩子
      await app.close();
      console.log('✅ Application closed successfully');

      // 等待 500ms 确保端口完全释放（避免 TIME_WAIT 状态导致的端口占用）
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('✅ Port cleanup completed');

      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  // 监听退出信号
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // 监听未捕获的异常
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
  });
}

bootstrap();
