import { Controller, Get } from '@nestjs/common';

@Controller('version')
export class VersionController {
  @Get()
  getVersion() {
    return {
      version: process.env.APP_VERSION ?? '0.0.1',
      name: process.env.APP_NAME ?? '{{ projectName }}',
      buildId: process.env.BUILD_ID ?? undefined,
    };
  }
}
