/**
 * @description Gateway Module - WebSocket 网关模块
 * @author Claude
 * @date 2025/11/16
 * @version v1.0.0
 */
import { Module, forwardRef } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { HttpModule } from '@nestjs/axios';
import { AppGateway } from './app.gateway';
import { DaemonGatewayModule } from '../module/daemon-gateway/daemon-gateway.module';
import { DeviceModule } from '../device/device.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    HttpModule,
    DeviceModule,
    forwardRef(() => DaemonGatewayModule),
  ],
  providers: [AppGateway],
  exports: [AppGateway],
})
export class GatewayModule {}
