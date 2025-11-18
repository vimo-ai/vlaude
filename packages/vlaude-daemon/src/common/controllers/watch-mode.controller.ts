/**
 * @description 监听模式控制器
 * @author Claude
 * @date 2025/11/16
 * @version v2.0.0
 */
import { Controller, Post, Get, Body, Logger } from '@nestjs/common';
import { FileWatcherService, WatchMode } from '../../module/file-watcher/file-watcher.service';

@Controller('watch-mode')
export class WatchModeController {
  private readonly logger = new Logger(WatchModeController.name);

  constructor(private readonly fileWatcherService: FileWatcherService) {}

  /**
   * 切换监听模式
   */
  @Post()
  async switchMode(@Body() body: { mode: WatchMode; target?: string }) {
    const { mode, target } = body;

    this.logger.log(`🔄 收到切换监听模式请求: ${mode}`);
    if (target) {
      this.logger.log(`   目标: ${target}`);
    }

    try {
      await this.fileWatcherService.switchWatchMode(mode, target);

      return {
        success: true,
        message: `监听模式已切换至: ${mode}`,
      };
    } catch (error) {
      this.logger.error(`❌ 切换监听模式失败: ${error.message}`);
      return {
        success: false,
        message: `切换失败: ${error.message}`,
      };
    }
  }

  /**
   * 获取当前监听状态
   */
  @Get('status')
  getStatus() {
    const status = this.fileWatcherService.getCurrentWatchStatus();
    return {
      success: true,
      data: status,
    };
  }
}
