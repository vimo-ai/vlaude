import { Module } from '@nestjs/common';
import { DeviceService } from './device.service';
import { DeviceController } from './device.controller';


@Module({
  imports: [],
  providers: [DeviceService],
  controllers: [DeviceController],
  exports: [DeviceService], // 导出供其他模块使用
})
export class DeviceModule {}
