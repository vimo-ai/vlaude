import { Module } from '@nestjs/common';
import { DataCollectorService } from './data-collector.service';
import { ServerClientModule } from '../server-client/server-client.module';

@Module({
  imports: [ServerClientModule],
  providers: [DataCollectorService],
  exports: [DataCollectorService],
})
export class DataCollectorModule {}
