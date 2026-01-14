/**
 * @description DataSync Service 单元测试
 * @author Claude
 * @date 2025/01/14
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSyncService, DaemonMessage, ApprovalStatus } from '../../module/data-sync';
import { ConfigService } from '@nestjs/config';

// Mock PrismaService
const mockPrisma = {
  project: {
    upsert: vi.fn(),
  },
  session: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
  },
  message: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
};

// Mock ConfigService
const createMockConfigService = (mode: string) => ({
  get: vi.fn((key: string, defaultValue: string) => {
    if (key === 'DATA_SYNC_MODE') return mode;
    return defaultValue;
  }),
});

describe('DataSyncService', () => {
  describe('Mode Detection', () => {
    it('should default to forward mode', async () => {
      const configService = createMockConfigService('forward');
      const service = new DataSyncService(
        configService as unknown as ConfigService,
        mockPrisma as any,
      );

      expect(service.getSyncMode()).toBe('forward');
      expect(service.isForwardMode()).toBe(true);
      expect(service.isSyncMode()).toBe(false);
    });

    it('should detect sync mode from config', async () => {
      const configService = createMockConfigService('sync');
      const service = new DataSyncService(
        configService as unknown as ConfigService,
        mockPrisma as any,
      );

      expect(service.getSyncMode()).toBe('sync');
      expect(service.isForwardMode()).toBe(false);
      expect(service.isSyncMode()).toBe(true);
    });

    it('should default to forward for invalid values', async () => {
      const configService = createMockConfigService('invalid');
      const service = new DataSyncService(
        configService as unknown as ConfigService,
        mockPrisma as any,
      );

      expect(service.getSyncMode()).toBe('forward');
    });
  });

  describe('Forward Mode Operations', () => {
    let service: DataSyncService;

    beforeEach(() => {
      const configService = createMockConfigService('forward');
      service = new DataSyncService(
        configService as unknown as ConfigService,
        mockPrisma as any,
      );
    });

    it('ensureProject should throw in forward mode', async () => {
      await expect(service.ensureProject('/test/path')).rejects.toThrow(
        'ensureProject only available in sync mode',
      );
    });

    it('ensureSession should throw in forward mode', async () => {
      await expect(service.ensureSession('session-1', 1, '/test/path')).rejects.toThrow(
        'ensureSession only available in sync mode',
      );
    });

    it('syncMessages should skip all in forward mode', async () => {
      const messages: DaemonMessage[] = [
        {
          uuid: 'msg-1',
          role: 'user',
          content: 'test',
          sequence: 1,
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await service.syncMessages(1, messages);
      expect(result).toEqual({ inserted: 0, updated: 0, skipped: 1 });
    });

    it('writeMessage should return false in forward mode', async () => {
      const message: DaemonMessage = {
        uuid: 'msg-1',
        role: 'user',
        content: 'test',
        sequence: 1,
        timestamp: new Date().toISOString(),
      };

      const result = await service.writeMessage(1, message);
      expect(result).toBe(false);
    });
  });

  describe('Sync Mode Operations', () => {
    let service: DataSyncService;

    beforeEach(() => {
      vi.clearAllMocks();
      const configService = createMockConfigService('sync');
      service = new DataSyncService(
        configService as unknown as ConfigService,
        mockPrisma as any,
      );
    });

    it('ensureProject should upsert project', async () => {
      mockPrisma.project.upsert.mockResolvedValue({ id: 1, path: '/test/path' });

      const result = await service.ensureProject('/test/path', 'Test Project');
      expect(result).toBe(1);
      expect(mockPrisma.project.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { path: '/test/path' },
        }),
      );
    });

    it('ensureSession should upsert session', async () => {
      mockPrisma.session.upsert.mockResolvedValue({ id: 1, sessionId: 'session-1' });

      const result = await service.ensureSession('session-1', 1, '/test/path');
      expect(result).toBe(1);
      expect(mockPrisma.session.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sessionId: 'session-1' },
        }),
      );
    });

    it('syncMessages should insert new messages', async () => {
      mockPrisma.message.findUnique.mockResolvedValue(null); // Message doesn't exist
      mockPrisma.message.create.mockResolvedValue({ id: 1 });

      const messages: DaemonMessage[] = [
        {
          uuid: 'msg-1',
          role: 'user',
          content: 'test',
          sequence: 1,
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await service.syncMessages(1, messages);
      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('syncMessages should update existing messages', async () => {
      mockPrisma.message.findUnique.mockResolvedValue({ id: 1 }); // Message exists
      mockPrisma.message.update.mockResolvedValue({ id: 1 });

      const messages: DaemonMessage[] = [
        {
          uuid: 'msg-1',
          role: 'user',
          content: 'test',
          sequence: 1,
          timestamp: new Date().toISOString(),
          approvalStatus: 'approved',
        },
      ];

      const result = await service.syncMessages(1, messages);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('syncMessages should skip messages without uuid', async () => {
      const messages: DaemonMessage[] = [
        {
          uuid: '', // Empty uuid
          role: 'user',
          content: 'test',
          sequence: 1,
          timestamp: new Date().toISOString(),
        },
      ];

      const result = await service.syncMessages(1, messages);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('writeMessage should handle P2002 as already synced', async () => {
      const error = new Error('Unique constraint violation');
      (error as any).code = 'P2002';
      mockPrisma.message.upsert.mockRejectedValue(error);

      const message: DaemonMessage = {
        uuid: 'msg-1',
        role: 'user',
        content: 'test',
        sequence: 1,
        timestamp: new Date().toISOString(),
      };

      const result = await service.writeMessage(1, message);
      expect(result).toBe(true); // Should return true for existing message
    });

    it('updateApprovalStatusByToolCallId should update status', async () => {
      mockPrisma.message.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.updateApprovalStatusByToolCallId(
        'tool-1',
        'approved' as ApprovalStatus,
        Date.now(),
      );
      expect(result).toBe(1);
      expect(mockPrisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { toolCallId: 'tool-1' },
        }),
      );
    });
  });
});
