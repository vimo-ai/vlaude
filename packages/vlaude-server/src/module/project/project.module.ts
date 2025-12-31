import { Module, forwardRef } from '@nestjs/common';
import { ProjectService } from './project.service';
import { ProjectController } from './project.controller';
import { DaemonGatewayModule } from '../daemon-gateway/daemon-gateway.module';

@Module({
  imports: [forwardRef(() => DaemonGatewayModule)],
  controllers: [ProjectController],
  providers: [ProjectService],
  exports: [ProjectService],
})
export class ProjectModule {}
