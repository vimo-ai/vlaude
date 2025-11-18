import { Module } from '@nestjs/common';
import { ProcessManagerService } from './process-manager.service';

@Module({
  providers: [ProcessManagerService],
  exports: [ProcessManagerService],
})
export class ProcessManagerModule {}
