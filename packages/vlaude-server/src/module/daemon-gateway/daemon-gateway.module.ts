import { Module, forwardRef } from '@nestjs/common';
import { DaemonGateway } from './daemon.gateway';
import { ProjectModule } from '../project/project.module';
import { SessionModule } from '../session/session.module';
import { GatewayModule } from '../../gateway/gateway.module';

@Module({
  imports: [
    ProjectModule,
    forwardRef(() => SessionModule),
    forwardRef(() => GatewayModule),
  ],
  providers: [DaemonGateway],
  exports: [DaemonGateway],
})
export class DaemonGatewayModule {}
