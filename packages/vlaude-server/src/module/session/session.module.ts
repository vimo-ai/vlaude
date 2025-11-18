import { Module, forwardRef } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { DaemonGatewayModule } from '../daemon-gateway/daemon-gateway.module';

@Module({
  imports: [forwardRef(() => DaemonGatewayModule)],
  controllers: [SessionController],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
