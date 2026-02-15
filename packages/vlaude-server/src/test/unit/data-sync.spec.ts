/**
 * @description DataSync Service 单元测试
 * @author Claude
 * @date 2025/01/14
 *
 * V2: 简化为纯 forward 模式测试
 */
import { describe, it, expect } from 'vitest';
import { DataSyncService } from '../../module/data-sync';

describe('DataSyncService', () => {
  it('should always be in forward mode', () => {
    const service = new DataSyncService();
    expect(service.isForwardMode()).toBe(true);
  });
});
