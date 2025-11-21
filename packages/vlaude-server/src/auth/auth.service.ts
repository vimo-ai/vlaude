import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DeviceService, DeviceType } from '../device/device.service';

export interface JwtPayload {
  clientId: string;       // 保留向后兼容
  clientType: 'daemon' | 'ios';
  deviceId?: string;      // 设备唯一标识
  deviceName?: string;    // 设备显示名称
  iat?: number;
  exp?: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly privateKey: string;

  constructor(
    private configService: ConfigService,
    private deviceService: DeviceService,
  ) {
    const privateKeyPath = this.configService.get<string>('JWT_PRIVATE_KEY_PATH');

    if (!privateKeyPath) {
      throw new Error('JWT_PRIVATE_KEY_PATH 未配置');
    }

    try {
      const fullPath = join(process.cwd(), privateKeyPath);
      this.privateKey = readFileSync(fullPath, 'utf-8');
      this.logger.log(`✅ JWT 私钥已加载: ${privateKeyPath}`);
    } catch (error) {
      throw new Error(`无法加载 JWT 私钥: ${error.message}`);
    }
  }

  /**
   * 生成 JWT Token（支持设备白名单）
   */
  async generateToken(
    clientId: string,
    clientType: 'daemon' | 'ios',
    deviceName?: string,
  ): Promise<{ success: boolean; token?: string; reason?: string }> {
    const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '7d');

    // deviceId 使用 clientId（iOS 为 identifierForVendor，Daemon 为 Mac UUID）
    const deviceId = clientId;

    // 如果提供了 deviceName，则注册设备
    if (deviceName) {
      const result = await this.deviceService.registerDevice({
        deviceId,
        deviceName,
        deviceType: clientType as DeviceType,
      });

      if (!result.success) {
        this.logger.error(
          `❌ 设备注册失败: ${deviceId} (${deviceName}), reason=${result.reason}`,
        );
        return { success: false, reason: result.reason };
      }
    } else {
      // 向后兼容：如果没有 deviceName，仍然验证设备是否存在且有效
      const isValid = await this.deviceService.verifyDevice(deviceId);
      if (!isValid) {
        this.logger.warn(
          `⚠️ 设备未注册或已撤销: ${deviceId}，但允许生成 Token（向后兼容）`,
        );
        // 向后兼容：旧客户端没有 deviceName，允许生成 Token
        // 未来可以改为严格模式：return { success: false, reason: 'device_not_registered' };
      }
    }

    // 生成 Token，包含设备信息
    const payload: JwtPayload = {
      clientId,
      clientType,
      deviceId,
      deviceName,
    };

    const token = jwt.sign(payload, this.privateKey, {
      algorithm: 'RS256',
      expiresIn,
    });

    return { success: true, token };
  }
}
