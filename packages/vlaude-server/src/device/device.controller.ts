import { Controller, Get, Post, Param, Query, Logger } from '@nestjs/common';
import { DeviceService, DeviceStatus } from './device.service';

/**
 * 设备管理接口
 * 建议：这些接口应该只允许内网访问（通过 IP 白名单或单独的管理 Token）
 */
@Controller('devices')
export class DeviceController {
  private readonly logger = new Logger(DeviceController.name);

  constructor(private readonly deviceService: DeviceService) {}

  /**
   * 列出所有设备
   * GET /devices?status=active
   */
  @Get()
  async listDevices(@Query('status') status?: DeviceStatus) {

    try {
      const devices = await this.deviceService.listDevices(status);

      return {
        success: true,
        data: {
          devices,
          total: devices.length,
        },
      };
    } catch (error) {
      this.logger.error(`❌ 列出设备失败: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * 获取单个设备信息
   * GET /devices/:deviceId
   */
  @Get(':deviceId')
  async getDevice(@Param('deviceId') deviceId: string) {

    try {
      const device = await this.deviceService.getDeviceById(deviceId);

      if (!device) {
        return {
          success: false,
          message: '设备不存在',
        };
      }

      return {
        success: true,
        data: device,
      };
    } catch (error) {
      this.logger.error(`❌ 获取设备信息失败: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * 撤销设备权限
   * POST /devices/:deviceId/revoke
   */
  @Post(':deviceId/revoke')
  async revokeDevice(@Param('deviceId') deviceId: string) {

    try {
      const result = await this.deviceService.revokeDevice(deviceId);

      return result;
    } catch (error) {
      this.logger.error(`❌ 撤销设备失败: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * 激活设备权限（恢复被撤销的设备）
   * POST /devices/:deviceId/activate
   */
  @Post(':deviceId/activate')
  async activateDevice(@Param('deviceId') deviceId: string) {

    try {
      const result = await this.deviceService.activateDevice(deviceId);

      return result;
    } catch (error) {
      this.logger.error(`❌ 激活设备失败: ${error.message}`);
      return {
        success: false,
        message: error.message,
      };
    }
  }
}
