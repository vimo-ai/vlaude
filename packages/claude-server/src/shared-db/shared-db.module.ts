/**
 * @description SharedDb 模块
 * @author Claude Code
 * @date 2025-12-30
 */

import { Module, Global } from '@nestjs/common';
import { SharedDbService } from './shared-db.service';

@Global()
@Module({
  providers: [SharedDbService],
  exports: [SharedDbService],
})
export class SharedDbModule {}
