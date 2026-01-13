/**
 * DaemonGateway 单元测试
 *
 * DaemonGateway 处理来自 ETerm/Daemon 的 WebSocket 事件：
 * - daemon:online → 调用 StatusService.handleDaemonOnline
 * - daemon:offline → 调用 StatusService.handleDaemonOffline
 * - daemon:sessionStart → 调用 StatusService.handleSessionStart
 * - daemon:sessionEnd → 调用 StatusService.handleSessionEnd
 * - daemon:heartbeat → 调用 StatusService.handleHeartbeat
 *
 * 测试重点：
 * - 事件数据是否正确传递给 StatusService
 * - connectedAt/startedAt 是否正确生成
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DaemonGateway } from '../../module/daemon-gateway/daemon.gateway';
import { StatusService } from '../../module/status';
import { RegistryService } from '../../module/registry/registry.service';

// =================== Mock 数据 ===================

const mockDaemonOnlineData = {
  deviceId: 'eterm',
  deviceName: 'My MacBook Pro',
  platform: 'darwin',
  version: '1.0.0',
};

const mockSessionStartData = {
  deviceId: 'eterm',
  sessionId: 'test-session-123',
  projectPath: '/Users/test/my-project',
  terminalId: 1,
};

// =================== Mock Services ===================

function createMockStatusService() {
  return {
    handleDaemonOnline: vi.fn().mockResolvedValue(undefined),
    handleDaemonOffline: vi.fn().mockResolvedValue(undefined),
    handleSessionStart: vi.fn().mockResolvedValue(undefined),
    handleSessionEnd: vi.fn().mockResolvedValue(undefined),
    handleHeartbeat: vi.fn().mockResolvedValue(undefined),
    isEtermOnline: vi.fn().mockResolvedValue(false),
    isSessionInEterm: vi.fn().mockResolvedValue(false),
    getEtermSessions: vi.fn().mockResolvedValue([]),
    getSessionCountsByProject: vi.fn().mockResolvedValue({}),
  };
}

function createMockRegistryService() {
  return {
    getDaemons: vi.fn().mockResolvedValue([]),
    getDaemon: vi.fn().mockResolvedValue(null),
  };
}

function createMockSocket() {
  return {
    id: 'socket-123',
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
}

// =================== 测试套件 ===================

describe('DaemonGateway', () => {
  let gateway: DaemonGateway;
  let mockStatusService: ReturnType<typeof createMockStatusService>;
  let mockRegistryService: ReturnType<typeof createMockRegistryService>;
  let mockEventEmitter: EventEmitter2;

  beforeEach(async () => {
    mockStatusService = createMockStatusService();
    mockRegistryService = createMockRegistryService();
    mockEventEmitter = {
      emit: vi.fn(),
    } as unknown as EventEmitter2;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DaemonGateway,
        {
          provide: StatusService,
          useValue: mockStatusService,
        },
        {
          provide: RegistryService,
          useValue: mockRegistryService,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    gateway = module.get<DaemonGateway>(DaemonGateway);
  });

  // =================== 1. daemon:online 事件测试 ===================

  describe('1. daemon:online 事件', () => {
    it('应调用 statusService.handleDaemonOnline', async () => {
      const socket = createMockSocket();

      await gateway.handleDaemonOnline(mockDaemonOnlineData, socket as any);

      expect(mockStatusService.handleDaemonOnline).toHaveBeenCalledWith(
        'eterm',
        expect.objectContaining({
          deviceId: 'eterm',
          deviceName: 'My MacBook Pro',
          platform: 'darwin',
          version: '1.0.0',
        }),
      );
    });

    it('应生成 connectedAt 时间戳', async () => {
      const socket = createMockSocket();
      const beforeCall = new Date();

      await gateway.handleDaemonOnline(mockDaemonOnlineData, socket as any);

      const afterCall = new Date();
      const callArgs = mockStatusService.handleDaemonOnline.mock.calls[0];
      const daemonInfo = callArgs[1];

      // connectedAt 应该是 Date 对象
      expect(daemonInfo.connectedAt).toBeInstanceOf(Date);

      // 时间应该在调用前后之间
      const connectedAt = daemonInfo.connectedAt as Date;
      expect(connectedAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(connectedAt.getTime()).toBeLessThanOrEqual(afterCall.getTime());
    });

    it('应返回 { success: true }', async () => {
      const socket = createMockSocket();

      const result = await gateway.handleDaemonOnline(
        mockDaemonOnlineData,
        socket as any,
      );

      expect(result).toEqual({ success: true });
    });
  });

  // =================== 2. daemon:offline 事件测试 ===================

  describe('2. daemon:offline 事件', () => {
    it('应调用 statusService.handleDaemonOffline', async () => {
      const socket = createMockSocket();

      await gateway.handleDaemonOffline({ deviceId: 'eterm' }, socket as any);

      expect(mockStatusService.handleDaemonOffline).toHaveBeenCalledWith(
        'eterm',
      );
    });

    it('应返回 { success: true }', async () => {
      const socket = createMockSocket();

      const result = await gateway.handleDaemonOffline(
        { deviceId: 'eterm' },
        socket as any,
      );

      expect(result).toEqual({ success: true });
    });
  });

  // =================== 3. daemon:sessionStart 事件测试 ===================

  describe('3. daemon:sessionStart 事件', () => {
    it('应调用 statusService.handleSessionStart', async () => {
      const socket = createMockSocket();

      await gateway.handleDaemonSessionStart(mockSessionStartData, socket as any);

      expect(mockStatusService.handleSessionStart).toHaveBeenCalledWith(
        'eterm',
        expect.objectContaining({
          sessionId: 'test-session-123',
          projectPath: '/Users/test/my-project',
          terminalId: 1,
        }),
      );
    });

    it('应生成 startedAt 时间戳', async () => {
      const socket = createMockSocket();
      const beforeCall = new Date();

      await gateway.handleDaemonSessionStart(mockSessionStartData, socket as any);

      const afterCall = new Date();
      const callArgs = mockStatusService.handleSessionStart.mock.calls[0];
      const sessionInfo = callArgs[1];

      // startedAt 应该是 Date 对象
      expect(sessionInfo.startedAt).toBeInstanceOf(Date);

      // 时间应该在调用前后之间
      const startedAt = sessionInfo.startedAt as Date;
      expect(startedAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(startedAt.getTime()).toBeLessThanOrEqual(afterCall.getTime());
    });

    it('terminalId 可选', async () => {
      const socket = createMockSocket();
      const dataWithoutTerminalId = {
        deviceId: 'eterm',
        sessionId: 'test-session-123',
        projectPath: '/Users/test/my-project',
      };

      await gateway.handleDaemonSessionStart(dataWithoutTerminalId, socket as any);

      const callArgs = mockStatusService.handleSessionStart.mock.calls[0];
      const sessionInfo = callArgs[1];

      expect(sessionInfo.terminalId).toBeUndefined();
    });

    it('应返回 { success: true }', async () => {
      const socket = createMockSocket();

      const result = await gateway.handleDaemonSessionStart(
        mockSessionStartData,
        socket as any,
      );

      expect(result).toEqual({ success: true });
    });
  });

  // =================== 4. daemon:sessionEnd 事件测试 ===================

  describe('4. daemon:sessionEnd 事件', () => {
    it('应调用 statusService.handleSessionEnd', async () => {
      const socket = createMockSocket();

      await gateway.handleDaemonSessionEnd(
        { deviceId: 'eterm', sessionId: 'test-session-123' },
        socket as any,
      );

      expect(mockStatusService.handleSessionEnd).toHaveBeenCalledWith(
        'eterm',
        'test-session-123',
      );
    });

    it('应返回 { success: true }', async () => {
      const socket = createMockSocket();

      const result = await gateway.handleDaemonSessionEnd(
        { deviceId: 'eterm', sessionId: 'test-session-123' },
        socket as any,
      );

      expect(result).toEqual({ success: true });
    });
  });

  // =================== 5. daemon:heartbeat 事件测试 ===================

  describe('5. daemon:heartbeat 事件', () => {
    it('应调用 statusService.handleHeartbeat', async () => {
      const socket = createMockSocket();

      await gateway.handleDaemonHeartbeat({ deviceId: 'eterm' }, socket as any);

      expect(mockStatusService.handleHeartbeat).toHaveBeenCalledWith('eterm');
    });

    it('应返回 { success: true }', async () => {
      const socket = createMockSocket();

      const result = await gateway.handleDaemonHeartbeat(
        { deviceId: 'eterm' },
        socket as any,
      );

      expect(result).toEqual({ success: true });
    });
  });

  // =================== 6. ETerm 状态查询方法测试 ===================

  describe('6. ETerm 状态查询方法', () => {
    it('isEtermOnline 应调用 statusService', async () => {
      mockStatusService.isEtermOnline.mockResolvedValue(true);

      const result = await gateway.isEtermOnline();

      expect(mockStatusService.isEtermOnline).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('isSessionInEterm 应调用 statusService', async () => {
      mockStatusService.isSessionInEterm.mockResolvedValue(true);

      const result = await gateway.isSessionInEterm('test-session');

      expect(mockStatusService.isSessionInEterm).toHaveBeenCalledWith(
        'test-session',
      );
      expect(result).toBe(true);
    });

    it('getEtermSessions 应调用 statusService', async () => {
      mockStatusService.getEtermSessions.mockResolvedValue([
        'session-1',
        'session-2',
      ]);

      const result = await gateway.getEtermSessions();

      expect(mockStatusService.getEtermSessions).toHaveBeenCalled();
      expect(result).toEqual(['session-1', 'session-2']);
    });

    it('getEtermSessionCounts 应调用 statusService', async () => {
      mockStatusService.getSessionCountsByProject.mockResolvedValue({
        '/project/a': 2,
        '/project/b': 1,
      });

      const result = await gateway.getEtermSessionCounts();

      expect(mockStatusService.getSessionCountsByProject).toHaveBeenCalled();
      expect(result).toEqual({
        '/project/a': 2,
        '/project/b': 1,
      });
    });
  });
});

// =================== 场景测试 ===================

describe('DaemonGateway 场景测试', () => {
  let gateway: DaemonGateway;
  let mockStatusService: ReturnType<typeof createMockStatusService>;

  beforeEach(async () => {
    mockStatusService = createMockStatusService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DaemonGateway,
        {
          provide: StatusService,
          useValue: mockStatusService,
        },
        {
          provide: RegistryService,
          useValue: createMockRegistryService(),
        },
        {
          provide: EventEmitter2,
          useValue: { emit: vi.fn() },
        },
      ],
    }).compile();

    gateway = module.get<DaemonGateway>(DaemonGateway);
  });

  describe('ETerm 正常启动流程', () => {
    it('daemon:online → sessionStart × N → 状态正确', async () => {
      const socket = createMockSocket();

      // Step 1: ETerm 发送 daemon:online
      await gateway.handleDaemonOnline(
        {
          deviceId: 'eterm',
          deviceName: 'MacBook Pro',
          platform: 'darwin',
          version: '1.0.0',
        },
        socket as any,
      );

      expect(mockStatusService.handleDaemonOnline).toHaveBeenCalledTimes(1);

      // Step 2: ETerm 打开多个 session
      await gateway.handleDaemonSessionStart(
        {
          deviceId: 'eterm',
          sessionId: 'session-1',
          projectPath: '/project/a',
        },
        socket as any,
      );

      await gateway.handleDaemonSessionStart(
        {
          deviceId: 'eterm',
          sessionId: 'session-2',
          projectPath: '/project/b',
        },
        socket as any,
      );

      expect(mockStatusService.handleSessionStart).toHaveBeenCalledTimes(2);

      // Step 3: 验证调用参数
      const call1 = mockStatusService.handleSessionStart.mock.calls[0];
      expect(call1[0]).toBe('eterm');
      expect(call1[1].sessionId).toBe('session-1');

      const call2 = mockStatusService.handleSessionStart.mock.calls[1];
      expect(call2[0]).toBe('eterm');
      expect(call2[1].sessionId).toBe('session-2');
    });
  });

  describe('心跳场景', () => {
    it('定期心跳应正确调用 handleHeartbeat', async () => {
      const socket = createMockSocket();

      // 模拟多次心跳
      for (let i = 0; i < 5; i++) {
        await gateway.handleDaemonHeartbeat({ deviceId: 'eterm' }, socket as any);
      }

      expect(mockStatusService.handleHeartbeat).toHaveBeenCalledTimes(5);
    });
  });

  describe('Session 关闭场景', () => {
    it('关闭 session 应调用 handleSessionEnd', async () => {
      const socket = createMockSocket();

      await gateway.handleDaemonSessionEnd(
        { deviceId: 'eterm', sessionId: 'session-1' },
        socket as any,
      );

      expect(mockStatusService.handleSessionEnd).toHaveBeenCalledWith(
        'eterm',
        'session-1',
      );
    });
  });
});
