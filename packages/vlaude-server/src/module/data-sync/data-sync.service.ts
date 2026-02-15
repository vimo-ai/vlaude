/**
 * @description DataSync Service - 数据同步服务
 * @author Claude
 * @date 2025/01/14
 * @version v2.0.0
 *
 * V2: 移除 Prisma/sync 模式，纯 forward 转发
 * 所有数据请求穿透到 Daemon，Server 不存储数据
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

// 消息数据类型（来自 Daemon）
export interface DaemonMessage {
  uuid: string;
  role: string;
  content: string;
  metadata?: any;
  sequence: number;
  timestamp: string | Date;
  toolCallId?: string;
  approvalStatus?: string;
  approvalResolvedAt?: number;
}

// 审批状态枚举
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

@Injectable()
export class DataSyncService implements OnModuleInit {
  private readonly logger = new Logger(DataSyncService.name);

  async onModuleInit() {
    this.logger.log('📊 [DataSync] 纯转发模式：所有请求穿透到 Daemon，不存储数据');
  }

  /**
   * 始终为纯转发模式
   */
  isForwardMode(): boolean {
    return true;
  }
}
