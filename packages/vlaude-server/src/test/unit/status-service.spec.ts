/**
 * StatusService 单元测试
 *
 * StatusService 是 StatusManager 的业务封装层，负责：
 * 1. 调用 StatusManager 进行状态管理
 * 2. 发布事件通知其他模块（如 AppGateway）
 *
 * 测试重点：
 * - 每个 handler 是否正确调用 StatusManager
 * - 每个 handler 是否正确发布事件
 * - 事件携带的数据是否正确
 */

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { StatusService, STATUS_MANAGER_TOKEN } from '../../module/status/status.service';
import {
  type IStatusManager,
  type StatusDaemonInfo as DaemonInfo,
  type StatusSessionInfo as SessionInfo,
} from '@vimo-ai/vlaude-shared-core';

// =================== Mock 数据工厂 ===================

function createDaemonInfo(overrides?: Partial<DaemonInfo>): DaemonInfo {
  return {
    deviceId: 'test-device-1',
    deviceName: 'Test MacBook',
    platform: 'darwin',
    version: '1.0.0',
    connectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createSessionInfo(overrides?: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 'test-session-1',
    projectPath: '/Users/test/project',
    terminalId: 1,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// =================== Mock StatusManager ===================

function createMockStatusManager(): IStatusManager {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    setDaemonOnline: vi.fn().mockResolvedValue({ isReconnect: false }),
    setDaemonOffline: vi.fn().mockResolvedValue(undefined),
    isDaemonOnline: vi.fn().mockResolvedValue(false),
    getOnlineDaemons: vi.fn().mockResolvedValue([]),
    getDaemonInfo: vi.fn().mockResolvedValue(null),
    addSession: vi.fn().mockResolvedValue({ success: true, reason: 'added' }),
    removeSession: vi.fn().mockResolvedValue(undefined),
    getSessionsByDevice: vi.fn().mockResolvedValue([]),
    getSessionCountsByProject: vi.fn().mockResolvedValue({}),
    isSessionOnline: vi.fn().mockResolvedValue(false),
    getSessionInfo: vi.fn().mockResolvedValue(null),
    getSnapshot: vi.fn().mockResolvedValue({
      daemons: [],
      sessions: {},
      sessionCounts: {},
      timestamp: Date.now(),
    }),
    heartbeat: vi.fn().mockResolvedValue(undefined),
  };
}

// =================== 测试套件 ===================

describe('StatusService', () => {
  let service: StatusService;
  let mockStatusManager: IStatusManager;
  let mockEventEmitter: EventEmitter2;

  beforeEach(async () => {
    mockStatusManager = createMockStatusManager();
    mockEventEmitter = {
      emit: vi.fn(),
    } as unknown as EventEmitter2;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusService,
        {
          provide: STATUS_MANAGER_TOKEN,
          useValue: mockStatusManager,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    service = module.get<StatusService>(StatusService);
  });

  // =================== 1. Daemon 事件处理测试 ===================

  describe('1. Daemon 事件处理', () => {
    describe('handleDaemonOnline', () => {
      it('应调用 statusManager.setDaemonOnline', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });

        await service.handleDaemonOnline('device-1', daemon);

        expect(mockStatusManager.setDaemonOnline).toHaveBeenCalledWith(
          'device-1',
          daemon,
        );
      });

      it('应发布 status.daemonOnline 事件', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        (mockStatusManager.setDaemonOnline as Mock).mockResolvedValue({
          isReconnect: false,
        });

        await service.handleDaemonOnline('device-1', daemon);

        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          'status.daemonOnline',
          {
            deviceId: 'device-1',
            info: daemon,
            isReconnect: false,
          },
        );
      });

      it('重连时事件应包含 isReconnect: true', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        (mockStatusManager.setDaemonOnline as Mock).mockResolvedValue({
          isReconnect: true,
        });

        await service.handleDaemonOnline('device-1', daemon);

        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          'status.daemonOnline',
          expect.objectContaining({
            isReconnect: true,
          }),
        );
      });
    });

    describe('handleDaemonOffline', () => {
      it('应获取 affected projects 后调用 setDaemonOffline', async () => {
        const sessions = [
          createSessionInfo({ projectPath: '/project/a' }),
          createSessionInfo({ projectPath: '/project/b' }),
          createSessionInfo({ projectPath: '/project/a' }), // 重复
        ];
        (mockStatusManager.getSessionsByDevice as Mock).mockResolvedValue(
          sessions,
        );

        await service.handleDaemonOffline('device-1');

        expect(mockStatusManager.getSessionsByDevice).toHaveBeenCalledWith(
          'device-1',
        );
        expect(mockStatusManager.setDaemonOffline).toHaveBeenCalledWith(
          'device-1',
        );
      });

      it('应发布 status.daemonOffline 事件，包含去重后的 affectedProjects', async () => {
        const sessions = [
          createSessionInfo({ projectPath: '/project/a' }),
          createSessionInfo({ projectPath: '/project/b' }),
          createSessionInfo({ projectPath: '/project/a' }),
        ];
        (mockStatusManager.getSessionsByDevice as Mock).mockResolvedValue(
          sessions,
        );

        await service.handleDaemonOffline('device-1');

        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          'status.daemonOffline',
          {
            deviceId: 'device-1',
            affectedProjects: expect.arrayContaining([
              '/project/a',
              '/project/b',
            ]),
          },
        );

        // 验证去重
        const emitCall = (mockEventEmitter.emit as Mock).mock.calls[0];
        expect(emitCall[1].affectedProjects).toHaveLength(2);
      });
    });
  });

  // =================== 2. Session 事件处理测试 ===================

  describe('2. Session 事件处理', () => {
    describe('handleSessionStart', () => {
      it('应调用 statusManager.addSession', async () => {
        const session = createSessionInfo({ sessionId: 'session-1' });

        await service.handleSessionStart('device-1', session);

        expect(mockStatusManager.addSession).toHaveBeenCalledWith(
          'device-1',
          session,
        );
      });

      it('成功时应发布 status.sessionOnline 事件', async () => {
        const session = createSessionInfo({ sessionId: 'session-1' });
        (mockStatusManager.addSession as Mock).mockResolvedValue({
          success: true,
          reason: 'added',
        });

        await service.handleSessionStart('device-1', session);

        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          'status.sessionOnline',
          {
            deviceId: 'device-1',
            session,
          },
        );
      });

      it('失败时不应发布事件', async () => {
        const session = createSessionInfo({ sessionId: 'session-1' });
        (mockStatusManager.addSession as Mock).mockResolvedValue({
          success: false,
          reason: 'daemon_not_found',
        });

        await service.handleSessionStart('device-1', session);

        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });
    });

    describe('handleSessionEnd', () => {
      it('应先获取 sessionInfo 再调用 removeSession', async () => {
        const sessionInfo = {
          session: createSessionInfo({ projectPath: '/project/a' }),
          deviceId: 'device-1',
        };
        (mockStatusManager.getSessionInfo as Mock).mockResolvedValue(
          sessionInfo,
        );

        await service.handleSessionEnd('device-1', 'session-1');

        expect(mockStatusManager.getSessionInfo).toHaveBeenCalledWith(
          'session-1',
        );
        expect(mockStatusManager.removeSession).toHaveBeenCalledWith(
          'device-1',
          'session-1',
        );
      });

      it('应发布 status.sessionOffline 事件，包含 projectPath', async () => {
        const sessionInfo = {
          session: createSessionInfo({ projectPath: '/project/a' }),
          deviceId: 'device-1',
        };
        (mockStatusManager.getSessionInfo as Mock).mockResolvedValue(
          sessionInfo,
        );

        await service.handleSessionEnd('device-1', 'session-1');

        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          'status.sessionOffline',
          {
            deviceId: 'device-1',
            sessionId: 'session-1',
            projectPath: '/project/a',
          },
        );
      });

      it('session 不存在时 projectPath 应为 undefined', async () => {
        (mockStatusManager.getSessionInfo as Mock).mockResolvedValue(null);

        await service.handleSessionEnd('device-1', 'session-1');

        expect(mockEventEmitter.emit).toHaveBeenCalledWith(
          'status.sessionOffline',
          {
            deviceId: 'device-1',
            sessionId: 'session-1',
            projectPath: undefined,
          },
        );
      });
    });
  });

  // =================== 3. 心跳测试 ===================

  describe('3. 心跳处理', () => {
    it('handleHeartbeat 应调用 statusManager.heartbeat', async () => {
      await service.handleHeartbeat('device-1');

      expect(mockStatusManager.heartbeat).toHaveBeenCalledWith('device-1');
    });
  });

  // =================== 4. 查询方法测试 ===================

  describe('4. 查询方法', () => {
    describe('isEtermOnline', () => {
      it('应查询 deviceId="eterm" 的在线状态', async () => {
        (mockStatusManager.isDaemonOnline as Mock).mockResolvedValue(true);

        const result = await service.isEtermOnline();

        expect(mockStatusManager.isDaemonOnline).toHaveBeenCalledWith('eterm');
        expect(result).toBe(true);
      });
    });

    describe('isSessionInEterm', () => {
      it('session 属于 eterm 时返回 true', async () => {
        (mockStatusManager.getSessionInfo as Mock).mockResolvedValue({
          session: createSessionInfo(),
          deviceId: 'eterm',
        });

        const result = await service.isSessionInEterm('session-1');

        expect(result).toBe(true);
      });

      it('session 不属于 eterm 时返回 false', async () => {
        (mockStatusManager.getSessionInfo as Mock).mockResolvedValue({
          session: createSessionInfo(),
          deviceId: 'other-device',
        });

        const result = await service.isSessionInEterm('session-1');

        expect(result).toBe(false);
      });

      it('session 不存在时返回 false', async () => {
        (mockStatusManager.getSessionInfo as Mock).mockResolvedValue(null);

        const result = await service.isSessionInEterm('session-1');

        expect(result).toBe(false);
      });
    });

    describe('getEtermSessions', () => {
      it('应返回 eterm 的 sessionId 列表', async () => {
        const sessions = [
          createSessionInfo({ sessionId: 'session-1' }),
          createSessionInfo({ sessionId: 'session-2' }),
        ];
        (mockStatusManager.getSessionsByDevice as Mock).mockResolvedValue(
          sessions,
        );

        const result = await service.getEtermSessions();

        expect(mockStatusManager.getSessionsByDevice).toHaveBeenCalledWith(
          'eterm',
        );
        expect(result).toEqual(['session-1', 'session-2']);
      });
    });
  });

  // =================== 5. 生命周期测试 ===================

  describe('5. 生命周期', () => {
    it('onModuleInit 应调用 statusManager.init', async () => {
      await service.onModuleInit();

      expect(mockStatusManager.init).toHaveBeenCalled();
    });

    it('onModuleDestroy 应调用 statusManager.destroy', async () => {
      await service.onModuleDestroy();

      expect(mockStatusManager.destroy).toHaveBeenCalled();
    });
  });
});

// =================== Bug 验证测试 ===================

describe('Bug 验证测试 - StatusService', () => {
  let service: StatusService;
  let mockStatusManager: IStatusManager;
  let mockEventEmitter: EventEmitter2;

  beforeEach(async () => {
    mockStatusManager = createMockStatusManager();
    mockEventEmitter = {
      emit: vi.fn(),
    } as unknown as EventEmitter2;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatusService,
        {
          provide: STATUS_MANAGER_TOKEN,
          useValue: mockStatusManager,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    service = module.get<StatusService>(StatusService);
  });

  describe('Bug #3: addSession 失败时的处理', () => {
    it('daemon_not_found 时应记录警告但不发布事件', async () => {
      const session = createSessionInfo({ sessionId: 'session-1' });
      (mockStatusManager.addSession as Mock).mockResolvedValue({
        success: false,
        reason: 'daemon_not_found',
      });

      // 不应抛出异常
      await expect(
        service.handleSessionStart('device-1', session),
      ).resolves.toBeUndefined();

      // 不应发布事件（session 添加失败）
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('daemon_not_found 时应重试（Bug #3 已修复）', async () => {
      // Bug #3 修复验证：daemon_not_found 时会重试

      const session = createSessionInfo({ sessionId: 'session-1' });

      // 第一次失败，第二次成功
      (mockStatusManager.addSession as Mock)
        .mockResolvedValueOnce({ success: false, reason: 'daemon_not_found' })
        .mockResolvedValueOnce({ success: true, reason: 'added' });

      await service.handleSessionStart('device-1', session);

      // 修复后应调用 2 次（第一次失败 + 重试成功）
      expect(mockStatusManager.addSession).toHaveBeenCalledTimes(2);

      // 重试成功后应发布事件
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'status.sessionOnline',
        expect.objectContaining({
          deviceId: 'device-1',
          session,
        }),
      );
    });
  });
});
