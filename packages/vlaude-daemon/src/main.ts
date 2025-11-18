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

  const app = await NestFactory.create(AppModule, fastifyAdapter ,);
  app.enableCors();
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));

  const port = process.env.PORT || 10006;
  await app.listen(port, '0.0.0.0');
  console.log(`Vlaude Daemon is running on: http://localhost:${port}`);
}

bootstrap();
