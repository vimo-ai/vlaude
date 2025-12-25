import { Controller, Post, Body, Logger, Req, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

class GenerateTokenDto {
  clientId: string;        // 设备唯一标识（iOS: identifierForVendor, Daemon: Mac UUID）
  clientType: 'daemon' | 'ios';
  deviceName?: string;     // 设备显示名称（可选，推荐提供）
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly ipWhitelist: string[];

  constructor(
    private authService: AuthService,
    private configService: ConfigService,
  ) {
    // 解析 IP 白名单
    const ipWhitelistConfig = this.configService.get<string>('IP_WHITELIST', '');
    this.ipWhitelist = ipWhitelistConfig
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
  }

  /**
   * 检查 IP 是否在白名单中
   */
  private isWhitelistedIp(ip: string): boolean {
    if (!ip || ip === 'unknown') return false;
    if (this.ipWhitelist.includes(ip)) return true;
    return this.ipWhitelist.some((cidr) => this.ipInCidr(ip, cidr));
  }

  private ipInCidr(ip: string, cidr: string): boolean {
    if (!cidr.includes('/')) return ip === cidr;
    const [subnet, bits] = cidr.split('/');
    const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1);
    const ipNum = ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
    const subnetNum = subnet.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
    return (ipNum & mask) === (subnetNum & mask);
  }

  private getClientIp(request: any): string {
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) return forwardedFor.split(',')[0].trim();
    const realIp = request.headers['x-real-ip'];
    if (realIp) return realIp;
    return request.ip || request.connection?.remoteAddress || 'unknown';
  }

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
  async generateToken(@Body() body: GenerateTokenDto, @Req() request: any) {
    // IP 白名单检查
    const clientIp = this.getClientIp(request);
    if (!this.isWhitelistedIp(clientIp)) {
      this.logger.warn(`❌ [Auth] 非白名单 IP 尝试生成 Token: ${clientIp}`);
      throw new ForbiddenException('Access denied: IP not in whitelist');
    }

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
