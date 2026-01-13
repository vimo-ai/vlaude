import { Module, forwardRef } from '@nestjs/common';
import { DaemonGateway } from './daemon.gateway';
import { GatewayModule } from '../../gateway/gateway.module';
import { RegistryModule } from '../registry/registry.module';
import { StatusModule } from '../status';

@Module({
  imports: [
    forwardRef(() => GatewayModule),
    forwardRef(() => RegistryModule),
    StatusModule.register(),
  ],
  providers: [DaemonGateway],
  exports: [DaemonGateway],
})
export class DaemonGatewayModule {}
