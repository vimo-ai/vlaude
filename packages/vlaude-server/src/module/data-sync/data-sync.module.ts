/**
 * @description DataSync Module - 数据同步模块
 * @author Claude
 * @date 2025/01/14
 */
import { Module, Global } from '@nestjs/common';
import { DataSyncService } from './data-sync.service';

@Global()
@Module({
  providers: [DataSyncService],
  exports: [DataSyncService],
})
export class DataSyncModule {}
