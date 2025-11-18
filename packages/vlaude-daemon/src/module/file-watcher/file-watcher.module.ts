import { Module } from '@nestjs/common';
import { FileWatcherService } from './file-watcher.service';
import { ServerClientModule } from '../server-client/server-client.module';

@Module({
  imports: [ServerClientModule],
  providers: [FileWatcherService],
  exports: [FileWatcherService],
})
export class FileWatcherModule {}
