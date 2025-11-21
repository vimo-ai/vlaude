import { Controller, Post, Body, Logger } from '@nestjs/common';
import { AuthService } from './auth.service';

class GenerateTokenDto {
  clientId: string;        // 设备唯一标识（iOS: identifierForVendor, Daemon: Mac UUID）
  clientType: 'daemon' | 'ios';
  deviceName?: string;     // 设备显示名称（可选，推荐提供）
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private authService: AuthService) {}

  /**
   * 生成 JWT Token（支持设备白名单）
   * POST /auth/generate-token
   * Body: {
   *   clientId: string,        // 设备唯一标识
   *   clientType: 'daemon' | 'ios',
   *   deviceName?: string      // 设备显示名称（推荐提供）
   * }
   */
  @Post('generate-token')
  async generateToken(@Body() body: GenerateTokenDto) {
    const { clientId, clientType, deviceName } = body;

    if (!clientId || !clientType) {
      return {
        success: false,
        message: 'clientId 和 clientType 为必填参数',
      };
    }

    if (clientType !== 'daemon' && clientType !== 'ios') {
      return {
        success: false,
        message: 'clientType 必须为 daemon 或 ios',
      };
    }

    try {
      const result = await this.authService.generateToken(
        clientId,
        clientType,
        deviceName,
      );

      if (!result.success) {
        this.logger.error(
          `❌ Token 生成失败: ${clientId} (${clientType}), reason=${result.reason}`,
        );
        return {
          success: false,
          message: `Token 生成失败: ${result.reason}`,
          reason: result.reason,
        };
      }

      return {
        success: true,
        data: {
          token: result.token,
        },
      };
    } catch (error) {
      this.logger.error(`❌ Token 生成失败: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }
}
