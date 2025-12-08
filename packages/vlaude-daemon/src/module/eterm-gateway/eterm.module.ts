import { Module, forwardRef } from '@nestjs/common';
import { EtermGateway } from './eterm.gateway';
import { ServerClientModule } from '../server-client/server-client.module';

@Module({
  imports: [forwardRef(() => ServerClientModule)],
  providers: [EtermGateway],
  exports: [EtermGateway],
})
export class EtermModule {}
