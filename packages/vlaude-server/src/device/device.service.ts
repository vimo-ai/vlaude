/**
 * @description Device Service - 设备管理服务
 * @author Claude
 * @date 2025/12/31
 * @version v3.0.0
 *
 * V3 架构改进:
 * - 移除 Prisma 依赖
 * - 使用内存存储（临时方案）
 * - 后续可改为 SQLite 持久化
 */
import { Injectable, Logger } from '@nestjs/common';

export type DeviceStatus = 'active' | 'revoked' | 'pending';
export type DeviceType = 'ios' | 'daemon' | 'web';

export interface Device {
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
  status: DeviceStatus;
  lastLoginAt: Date;
  createdAt: Date;
}

export interface RegisterDeviceDto {
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
}

@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);

  // 内存存储（临时方案）
  private devices = new Map<string, Device>();

  constructor() {
    this.logger.log('DeviceService 初始化（内存模式）');
  }

  /**
   * 注册或激活设备（信任模型：首次登录自动激活）
   */
  async registerDevice(dto: RegisterDeviceDto) {
    const { deviceId, deviceName, deviceType } = dto;

    // 检查设备是否已存在
    const existingDevice = this.devices.get(deviceId);

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
    const newDevice: Device = {
      deviceId,
      deviceName,
      deviceType,
      status: 'active',
      lastLoginAt: new Date(),
      createdAt: new Date(),
    };

    this.devices.set(deviceId, newDevice);

    this.logger.log(
      `🆕 新设备已注册并激活: ${deviceId} (${deviceName}, ${deviceType})`,
    );
    return { success: true, device: newDevice, isNew: true };
  }

  /**
   * 验证设备是否有效（active 状态）
   * 在内存模式下，默认信任所有设备
   */
  async verifyDevice(deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId);

    // 如果设备不存在，自动注册（内存模式下的宽松策略）
    if (!device) {
      this.logger.log(`📱 设备 ${deviceId} 不存在，自动信任`);
      return true; // 内存模式下默认信任
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
    const device = this.devices.get(deviceId);

    if (!device) {
      this.logger.warn(`❌ 设备不存在，无法撤销: ${deviceId}`);
      return { success: false, reason: 'device_not_found' };
    }

    device.status = 'revoked';
    this.devices.set(deviceId, device);

    this.logger.warn(`🚫 设备已撤销: ${deviceId} (${device.deviceName})`);
    return { success: true };
  }

  /**
   * 恢复设备权限（从 revoked 恢复到 active）
   */
  async activateDevice(deviceId: string) {
    const device = this.devices.get(deviceId);

    if (!device) {
      this.logger.warn(`❌ 设备不存在，无法激活: ${deviceId}`);
      return { success: false, reason: 'device_not_found' };
    }

    device.status = 'active';
    this.devices.set(deviceId, device);

    this.logger.log(`✅ 设备已激活: ${deviceId} (${device.deviceName})`);
    return { success: true };
  }

  /**
   * 更新最后登录时间
   */
  async updateLastLogin(deviceId: string) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastLoginAt = new Date();
      this.devices.set(deviceId, device);
    }
  }

  /**
   * 获取设备信息
   */
  async getDeviceById(deviceId: string) {
    return this.devices.get(deviceId) || null;
  }

  /**
   * 列出所有设备
   */
  async listDevices(status?: DeviceStatus) {
    const allDevices = Array.from(this.devices.values());

    if (status) {
      return allDevices.filter(d => d.status === status);
    }

    return allDevices.sort((a, b) =>
      b.lastLoginAt.getTime() - a.lastLoginAt.getTime()
    );
  }

  /**
   * 列出活跃设备
   */
  async listActiveDevices() {
    return this.listDevices('active');
  }
}
