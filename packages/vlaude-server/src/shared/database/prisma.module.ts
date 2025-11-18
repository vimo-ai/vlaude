/**
 * @description Prisma Module - 数据库访问层模块
 * @author Claude
 * @date 2025/11/16
 * @version v1.0.0
 *
 * 江湖的业务千篇一律,复杂的代码好几百行。
 */
import { Module, DynamicModule, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Module({})
export class PrismaModule implements OnModuleInit {
  constructor(private prismaService: PrismaService) {}

  async onModuleInit() {
    console.log('connect prisma database...')
    await this.prismaService.$connect();
    console.log(`connect prisma database: ${process.env.DATABASE_URL} success`)
  }

  static forRoot(): DynamicModule {
    return {
      module: PrismaModule,
      global: true,
      providers: [PrismaService],
      exports: [PrismaService],
    };
  }
}
