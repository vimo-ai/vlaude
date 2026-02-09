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
import { DataSyncService } from '../../module/data-sync';

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

function createMockDataSyncService() {
  return {
    getSyncMode: vi.fn().mockReturnValue('forward'),
    isForwardMode: vi.fn().mockReturnValue(true),
    isSyncMode: vi.fn().mockReturnValue(false),
    getMessagesFromDb: vi.fn().mockResolvedValue(null),
    ensureProject: vi.fn().mockResolvedValue(1),
    ensureSession: vi.fn().mockResolvedValue(1),
    syncMessages: vi.fn().mockResolvedValue(undefined),
    writeMessage: vi.fn().mockResolvedValue(undefined),
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
        {
          provide: DataSyncService,
          useValue: createMockDataSyncService(),
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
        {
          provide: DataSyncService,
          useValue: createMockDataSyncService(),
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

// =================== Chunk 组装测试 ===================

describe('DaemonGateway Chunk 组装', () => {
  let gateway: DaemonGateway;
  let mockStatusService: ReturnType<typeof createMockStatusService>;

  beforeEach(async () => {
    mockStatusService = createMockStatusService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DaemonGateway,
        { provide: StatusService, useValue: mockStatusService },
        { provide: RegistryService, useValue: createMockRegistryService() },
        { provide: EventEmitter2, useValue: { emit: vi.fn() } },
        { provide: DataSyncService, useValue: createMockDataSyncService() },
      ],
    }).compile();

    gateway = module.get<DaemonGateway>(DaemonGateway);
  });

  it('单个 chunk (total=1) 应直接组装并分派', async () => {
    const socket = createMockSocket();
    const payload = {
      sessionId: 's1',
      projectPath: '/p',
      messages: [{ text: 'hello' }],
      total: 1,
      hasMore: false,
      requestId: 'req_1',
    };
    const jsonStr = JSON.stringify(payload);

    // 单个 chunk 应该直接处理，不应该抛异常
    expect(() => {
      gateway.handleChunk(
        {
          transferId: 'tx_1',
          event: 'daemon:sessionMessages',
          seq: 0,
          total: 1,
          data: jsonStr,
        },
        socket as any,
      );
    }).not.toThrow();
  });

  it('多个 chunk 凑齐后正确组装 JSON 并分派到 handleSessionMessages', async () => {
    const socket = createMockSocket();
    const payload = {
      sessionId: 's1',
      projectPath: '/p',
      messages: [{ text: 'hello' }],
      total: 1,
      hasMore: false,
      requestId: 'req_test',
    };
    const jsonStr = JSON.stringify(payload);

    // 把 jsonStr 切成 3 段
    const chunkSize = Math.ceil(jsonStr.length / 3);
    const chunk0 = jsonStr.slice(0, chunkSize);
    const chunk1 = jsonStr.slice(chunkSize, chunkSize * 2);
    const chunk2 = jsonStr.slice(chunkSize * 2);

    // 设置 pending request 以验证分派
    let resolvedValue: any = null;
    (gateway as any).pendingMessageRequests.set('req_test', {
      resolve: (val: any) => {
        resolvedValue = val;
      },
      timer: setTimeout(() => {}, 10000),
      startTime: Date.now(),
    });

    // 发送前两个 chunk
    gateway.handleChunk(
      {
        transferId: 'tx_2',
        event: 'daemon:sessionMessages',
        seq: 0,
        total: 3,
        data: chunk0,
      },
      socket as any,
    );
    gateway.handleChunk(
      {
        transferId: 'tx_2',
        event: 'daemon:sessionMessages',
        seq: 1,
        total: 3,
        data: chunk1,
      },
      socket as any,
    );

    // 还没凑齐，不应该 resolve
    expect(resolvedValue).toBeNull();

    // 发送最后一个 chunk
    gateway.handleChunk(
      {
        transferId: 'tx_2',
        event: 'daemon:sessionMessages',
        seq: 2,
        total: 3,
        data: chunk2,
      },
      socket as any,
    );

    // 应该 resolve 了
    expect(resolvedValue).not.toBeNull();
    expect(resolvedValue.messages).toHaveLength(1);
    expect(resolvedValue.total).toBe(1);
  });

  it('chunk 乱序到达也能正确组装', async () => {
    const socket = createMockSocket();
    const payload = {
      sessionId: 's1',
      projectPath: '/p',
      messages: [],
      total: 0,
      hasMore: false,
      requestId: 'req_ooo',
    };
    const jsonStr = JSON.stringify(payload);
    const mid = Math.ceil(jsonStr.length / 2);
    const chunk0 = jsonStr.slice(0, mid);
    const chunk1 = jsonStr.slice(mid);

    let resolvedValue: any = null;
    (gateway as any).pendingMessageRequests.set('req_ooo', {
      resolve: (val: any) => {
        resolvedValue = val;
      },
      timer: setTimeout(() => {}, 10000),
      startTime: Date.now(),
    });

    // 先发 seq=1，再发 seq=0
    gateway.handleChunk(
      {
        transferId: 'tx_ooo',
        event: 'daemon:sessionMessages',
        seq: 1,
        total: 2,
        data: chunk1,
      },
      socket as any,
    );
    gateway.handleChunk(
      {
        transferId: 'tx_ooo',
        event: 'daemon:sessionMessages',
        seq: 0,
        total: 2,
        data: chunk0,
      },
      socket as any,
    );

    expect(resolvedValue).not.toBeNull();
    expect(resolvedValue.total).toBe(0);
  });

  it('不完整 chunk 不触发分派', () => {
    const socket = createMockSocket();

    let resolvedValue: any = null;
    (gateway as any).pendingMessageRequests.set('req_partial', {
      resolve: (val: any) => {
        resolvedValue = val;
      },
      timer: setTimeout(() => {}, 10000),
      startTime: Date.now(),
    });

    gateway.handleChunk(
      {
        transferId: 'tx_partial',
        event: 'daemon:sessionMessages',
        seq: 0,
        total: 3,
        data: '{"partial',
      },
      socket as any,
    );
    gateway.handleChunk(
      {
        transferId: 'tx_partial',
        event: 'daemon:sessionMessages',
        seq: 2,
        total: 3,
        data: '": true}',
      },
      socket as any,
    );

    // 只收到 2/3，不应该 resolve
    expect(resolvedValue).toBeNull();
  });
});
