import { Module } from '@nestjs/common';
import { DeviceService } from './device.service';
import { DeviceController } from './device.controller';
import { PrismaModule } from '../shared/database/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [DeviceService],
  controllers: [DeviceController],
  exports: [DeviceService], // 导出供其他模块使用
})
export class DeviceModule {}
