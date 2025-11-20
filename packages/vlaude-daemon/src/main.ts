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

async function bootstrap() {

  const fastifyAdapter = new FastifyAdapter();
  fastifyAdapter.register(fastifyMultipart , {})

  const app = await NestFactory.create(AppModule, fastifyAdapter);
  app.enableCors();
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));

  const port = process.env.PORT || 10006;
  await app.listen(port, '0.0.0.0');
  console.log(`Vlaude Daemon is running on: http://localhost:${port}`);

  // 优雅关闭处理 - 解决热重启时端口占用问题
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n⚠️ Received ${signal}, starting graceful shutdown...`);

    try {
      // 停止接收新请求，触发所有模块的 onModuleDestroy 钩子
      await app.close();
      console.log('✅ Application closed successfully');

      // 等待 1000ms 确保端口完全释放（避免 TIME_WAIT 状态导致的端口占用）
      await new Promise(resolve => setTimeout(resolve, 1000));
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
