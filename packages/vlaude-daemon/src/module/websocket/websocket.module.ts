import { Module } from '@nestjs/common';
import { VlaudeWebSocketGateway } from './websocket.gateway';

@Module({
  providers: [VlaudeWebSocketGateway],
  exports: [VlaudeWebSocketGateway],
})
export class VlaudeWebSocketModule {}
