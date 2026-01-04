import { Module, forwardRef } from '@nestjs/common';
import { DaemonGateway } from './daemon.gateway';
import { ProjectModule } from '../project/project.module';
import { SessionModule } from '../session/session.module';
import { GatewayModule } from '../../gateway/gateway.module';
import { RegistryModule } from '../registry/registry.module';

@Module({
  imports: [
    ProjectModule,
    forwardRef(() => SessionModule),
    forwardRef(() => GatewayModule),
    forwardRef(() => RegistryModule),
  ],
  providers: [DaemonGateway],
  exports: [DaemonGateway],
})
export class DaemonGatewayModule {}
