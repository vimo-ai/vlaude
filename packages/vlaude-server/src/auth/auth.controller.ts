import { Controller, Post, Body, Logger } from '@nestjs/common';
import { AuthService } from './auth.service';

class GenerateTokenDto {
  clientId: string;
  clientType: 'daemon' | 'ios';
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private authService: AuthService) {}

  /**
   * 生成 JWT Token
   * POST /auth/generate-token
   * Body: { clientId: string, clientType: 'daemon' | 'ios' }
   */
  @Post('generate-token')
  generateToken(@Body() body: GenerateTokenDto) {
    const { clientId, clientType } = body;

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
      const token = this.authService.generateToken(clientId, clientType);
      this.logger.log(`✅ Token 生成成功: ${clientId} (${clientType})`);

      return {
        success: true,
        data: {
          token,
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
