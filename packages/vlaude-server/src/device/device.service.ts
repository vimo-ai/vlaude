import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../shared/database/prisma.service';

export type DeviceStatus = 'active' | 'revoked' | 'pending';
export type DeviceType = 'ios' | 'daemon' | 'web';

export interface RegisterDeviceDto {
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
}

@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 注册或激活设备（信任模型：首次登录自动激活）
   */
  async registerDevice(dto: RegisterDeviceDto) {
    const { deviceId, deviceName, deviceType } = dto;

    // 检查设备是否已存在
    const existingDevice = await this.prisma.device.findUnique({
      where: { deviceId },
    });

    if (existingDevice) {
      // 如果设备已存在
      if (existingDevice.status === 'revoked') {
        this.logger.warn(
          `🚫 设备已被撤销，拒绝激活: ${deviceId} (${deviceName})`,
        );
        return { success: false, reason: 'device_revoked' };
      }

      // 更新最后登录时间（静默）
      await this.updateLastLogin(deviceId);
      return { success: true, device: existingDevice, isNew: false };
    }

    // 新设备：自动激活（信任模型）
    const newDevice = await this.prisma.device.create({
      data: {
        deviceId,
        deviceName,
        deviceType,
        status: 'active', // 自动激活
        lastLoginAt: new Date(),
      },
    });

    this.logger.log(
      `🆕 新设备已注册并激活: ${deviceId} (${deviceName}, ${deviceType})`,
    );
    return { success: true, device: newDevice, isNew: true };
  }

  /**
   * 验证设备是否有效（active 状态）
   */
  async verifyDevice(deviceId: string): Promise<boolean> {
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
    });

    if (!device) {
      this.logger.warn(`❌ 设备不存在: ${deviceId}`);
      return false;
    }

    if (device.status !== 'active') {
      this.logger.warn(
        `❌ 设备状态无效: ${deviceId}, status=${device.status}`,
      );
      return false;
    }

    return true;
  }

  /**
   * 撤销设备权限
   */
  async revokeDevice(deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
    });

    if (!device) {
      this.logger.warn(`❌ 设备不存在，无法撤销: ${deviceId}`);
      return { success: false, reason: 'device_not_found' };
    }

    await this.prisma.device.update({
      where: { deviceId },
      data: { status: 'revoked' },
    });

    this.logger.warn(`🚫 设备已撤销: ${deviceId} (${device.deviceName})`);
    return { success: true };
  }

  /**
   * 恢复设备权限（从 revoked 恢复到 active）
   */
  async activateDevice(deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
    });

    if (!device) {
      this.logger.warn(`❌ 设备不存在，无法激活: ${deviceId}`);
      return { success: false, reason: 'device_not_found' };
    }

    await this.prisma.device.update({
      where: { deviceId },
      data: { status: 'active' },
    });

    this.logger.log(`✅ 设备已激活: ${deviceId} (${device.deviceName})`);
    return { success: true };
  }

  /**
   * 更新最后登录时间
   */
  async updateLastLogin(deviceId: string) {
    await this.prisma.device.update({
      where: { deviceId },
      data: { lastLoginAt: new Date() },
    });
  }

  /**
   * 获取设备信息
   */
  async getDeviceById(deviceId: string) {
    return this.prisma.device.findUnique({
      where: { deviceId },
    });
  }

  /**
   * 列出所有设备
   */
  async listDevices(status?: DeviceStatus) {
    return this.prisma.device.findMany({
      where: status ? { status } : undefined,
      orderBy: { lastLoginAt: 'desc' },
    });
  }

  /**
   * 列出活跃设备
   */
  async listActiveDevices() {
    return this.listDevices('active');
  }
}
