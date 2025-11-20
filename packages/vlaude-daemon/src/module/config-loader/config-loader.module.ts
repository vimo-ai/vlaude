import { Module } from '@nestjs/common';
import { ConfigLoaderService } from './config-loader.service';

@Module({
  providers: [ConfigLoaderService],
  exports: [ConfigLoaderService],
})
export class ConfigLoaderModule {}
