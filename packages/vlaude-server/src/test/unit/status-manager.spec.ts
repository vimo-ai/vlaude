/**
 * StatusManager 单元测试
 * 基于 PLAN_STATUS_MANAGER_REFACTOR.md 中的测试用例设计
 *
 * 测试内容：
 * 1. 状态机测试 - Daemon/Session 状态转换
 * 2. 契约测试 - 每个操作的前置/后置条件验证
 * 3. 不变量测试 - Session 在线 → Daemon 必须在线
 * 4. 场景测试 - 各种启动顺序、断线重连
 *
 * 注意：使用 MemoryStatusManager 进行单元测试（无需 Redis）
 * TTL 过期相关测试需要 RedisStatusManager 集成测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  type IStatusManager,
  type StatusDaemonInfo as DaemonInfo,
  type StatusSessionInfo as SessionInfo,
  MemoryStatusManager,
} from '@vimo-ai/vlaude-shared-core';

// =================== 测试数据工厂 ===================

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

// =================== 测试套件 ===================

describe('StatusManager', () => {
  let manager: IStatusManager;

  beforeEach(async () => {
    manager = new MemoryStatusManager();
    await manager.init();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  // =================== 1. 状态机测试 ===================

  describe('1. 状态机测试', () => {
    describe('1.1 Daemon 状态转换', () => {
      it('Offline → Online: daemon:online 使 daemon 上线', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });

        // 前置: daemon 不在线
        expect(await manager.isDaemonOnline('device-1')).toBe(false);

        // 操作: setDaemonOnline
        const result = await manager.setDaemonOnline('device-1', daemon);

        // 后置: daemon 在线，isReconnect = false
        expect(result.isReconnect).toBe(false);
        expect(await manager.isDaemonOnline('device-1')).toBe(true);
      });

      it('Online → Online: heartbeat 保持 daemon 在线', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        await manager.setDaemonOnline('device-1', daemon);

        // 操作: heartbeat（Memory 模式下是空操作）
        await manager.heartbeat('device-1');

        // 后置: daemon 仍在线
        expect(await manager.isDaemonOnline('device-1')).toBe(true);
      });

      it('Online → Offline: daemon:offline 使 daemon 下线', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        await manager.setDaemonOnline('device-1', daemon);

        // 前置: daemon 在线
        expect(await manager.isDaemonOnline('device-1')).toBe(true);

        // 操作: setDaemonOffline
        await manager.setDaemonOffline('device-1');

        // 后置: daemon 不在线
        expect(await manager.isDaemonOnline('device-1')).toBe(false);
      });

      it('Online → Online: 重连时 isReconnect = true', async () => {
        const daemon1 = createDaemonInfo({
          deviceId: 'device-1',
          version: '1.0.0',
        });
        const daemon2 = createDaemonInfo({
          deviceId: 'device-1',
          version: '2.0.0',
        });

        // 第一次上线
        const result1 = await manager.setDaemonOnline('device-1', daemon1);
        expect(result1.isReconnect).toBe(false);

        // 重连
        const result2 = await manager.setDaemonOnline('device-1', daemon2);
        expect(result2.isReconnect).toBe(true);

        // 后置: daemon 信息已更新
        const info = await manager.getDaemonInfo('device-1');
        expect(info?.version).toBe('2.0.0');
      });
    });

    describe('1.2 Session 状态转换', () => {
      it('NotExist → Online: sessionStart 在 daemon 在线时成功', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session = createSessionInfo({ sessionId: 'session-1' });

        // 前置: daemon 在线
        await manager.setDaemonOnline('device-1', daemon);

        // 操作: addSession
        const result = await manager.addSession('device-1', session);

        // 后置: session 在线
        expect(result.success).toBe(true);
        expect(result.reason).toBe('added');
        expect(await manager.isSessionOnline('session-1')).toBe(true);
      });

      it('NotExist → NotExist: sessionStart 在 daemon 不在线时失败', async () => {
        const session = createSessionInfo({ sessionId: 'session-1' });

        // 前置: daemon 不在线
        expect(await manager.isDaemonOnline('device-1')).toBe(false);

        // 操作: addSession
        const result = await manager.addSession('device-1', session);

        // 后置: session 未添加
        expect(result.success).toBe(false);
        expect(result.reason).toBe('daemon_not_found');
        expect(await manager.isSessionOnline('session-1')).toBe(false);
      });

      it('Online → NotExist: sessionEnd 移除 session', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session = createSessionInfo({ sessionId: 'session-1' });

        await manager.setDaemonOnline('device-1', daemon);
        await manager.addSession('device-1', session);

        // 前置: session 在线
        expect(await manager.isSessionOnline('session-1')).toBe(true);

        // 操作: removeSession
        await manager.removeSession('device-1', 'session-1');

        // 后置: session 不在线
        expect(await manager.isSessionOnline('session-1')).toBe(false);
      });

      it('Online → NotExist: daemon 下线时清除所有 sessions', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session1 = createSessionInfo({ sessionId: 'session-1' });
        const session2 = createSessionInfo({ sessionId: 'session-2' });

        await manager.setDaemonOnline('device-1', daemon);
        await manager.addSession('device-1', session1);
        await manager.addSession('device-1', session2);

        // 前置: 两个 session 都在线
        expect(await manager.isSessionOnline('session-1')).toBe(true);
        expect(await manager.isSessionOnline('session-2')).toBe(true);

        // 操作: daemon 下线
        await manager.setDaemonOffline('device-1');

        // 后置: 所有 session 都被清除
        expect(await manager.isSessionOnline('session-1')).toBe(false);
        expect(await manager.isSessionOnline('session-2')).toBe(false);
      });
    });
  });

  // =================== 2. 契约测试 ===================

  describe('2. 契约测试', () => {
    describe('2.1 daemon:online 契约', () => {
      it('输入有效 → 状态存在', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });

        await manager.setDaemonOnline('device-1', daemon);

        // 后置条件验证
        expect(await manager.isDaemonOnline('device-1')).toBe(true);
        const info = await manager.getDaemonInfo('device-1');
        expect(info).not.toBeNull();
        expect(info?.deviceId).toBe('device-1');
        expect(info?.deviceName).toBe(daemon.deviceName);
      });

      it('重复调用 → 幂等，不报错', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });

        await manager.setDaemonOnline('device-1', daemon);
        // 不应抛出异常
        await expect(
          manager.setDaemonOnline('device-1', daemon),
        ).resolves.toBeDefined();

        // 状态仍正常
        expect(await manager.isDaemonOnline('device-1')).toBe(true);
      });
    });

    describe('2.2 daemon:sessionStart 契约', () => {
      it('daemon 在线 + 有效输入 → session 记录存在', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session = createSessionInfo({ sessionId: 'session-1' });

        await manager.setDaemonOnline('device-1', daemon);
        const result = await manager.addSession('device-1', session);

        // 后置条件验证
        expect(result.success).toBe(true);
        expect(result.reason).toBe('added');

        const info = await manager.getSessionInfo('session-1');
        expect(info).not.toBeNull();
        expect(info?.session.sessionId).toBe('session-1');
        expect(info?.deviceId).toBe('device-1');
      });

      it('daemon 不在线 → 返回 daemon_not_found', async () => {
        const session = createSessionInfo({ sessionId: 'session-1' });

        const result = await manager.addSession('device-1', session);

        expect(result.success).toBe(false);
        expect(result.reason).toBe('daemon_not_found');
      });

      it('重复调用 → 幂等，返回 updated', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session = createSessionInfo({ sessionId: 'session-1' });

        await manager.setDaemonOnline('device-1', daemon);

        const result1 = await manager.addSession('device-1', session);
        expect(result1.reason).toBe('added');

        const result2 = await manager.addSession('device-1', session);
        expect(result2.success).toBe(true);
        expect(result2.reason).toBe('updated');
      });
    });

    describe('2.3 daemon:sessionEnd 契约', () => {
      it('session 存在 → 移除成功', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session = createSessionInfo({ sessionId: 'session-1' });

        await manager.setDaemonOnline('device-1', daemon);
        await manager.addSession('device-1', session);
        expect(await manager.isSessionOnline('session-1')).toBe(true);

        await manager.removeSession('device-1', 'session-1');

        expect(await manager.isSessionOnline('session-1')).toBe(false);
      });

      it('session 不存在 → 幂等，静默成功', async () => {
        // 不应抛出异常
        await expect(
          manager.removeSession('device-1', 'non-existent-session'),
        ).resolves.toBeUndefined();
      });
    });

    describe('2.4 daemon:offline 契约', () => {
      it('daemon 存在 → 下线成功', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        await manager.setDaemonOnline('device-1', daemon);

        await manager.setDaemonOffline('device-1');

        expect(await manager.isDaemonOnline('device-1')).toBe(false);
      });

      it('daemon 不存在 → 幂等，静默成功', async () => {
        // 不应抛出异常
        await expect(
          manager.setDaemonOffline('non-existent-device'),
        ).resolves.toBeUndefined();
      });
    });

    describe('2.5 getSnapshot 契约', () => {
      it('有在线 session → 返回 session 列表', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session = createSessionInfo({
          sessionId: 'session-1',
          projectPath: '/project/a',
        });

        await manager.setDaemonOnline('device-1', daemon);
        await manager.addSession('device-1', session);

        const snapshot = await manager.getSnapshot();

        expect(snapshot.daemons).toHaveLength(1);
        expect(snapshot.daemons[0].deviceId).toBe('device-1');
        expect(snapshot.sessions['device-1']).toHaveLength(1);
        expect(snapshot.sessions['device-1'][0].sessionId).toBe('session-1');
        expect(snapshot.sessionCounts['/project/a']).toBe(1);
      });

      it('无在线 session → 返回空数组', async () => {
        const snapshot = await manager.getSnapshot();

        expect(snapshot.daemons).toHaveLength(0);
        expect(Object.keys(snapshot.sessions)).toHaveLength(0);
        expect(Object.keys(snapshot.sessionCounts)).toHaveLength(0);
      });
    });
  });

  // =================== 3. 不变量测试 ===================

  describe('3. 不变量测试', () => {
    describe('3.1 Session 在线 → Daemon 必须在线', () => {
      it('添加 session 后 daemon 必须存在', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session = createSessionInfo({ sessionId: 'session-1' });

        await manager.setDaemonOnline('device-1', daemon);
        await manager.addSession('device-1', session);

        // 不变量验证
        if (await manager.isSessionOnline('session-1')) {
          expect(await manager.isDaemonOnline('device-1')).toBe(true);
        }
      });

      it('daemon 下线后所有 session 都被清除', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session1 = createSessionInfo({ sessionId: 'session-1' });
        const session2 = createSessionInfo({ sessionId: 'session-2' });

        await manager.setDaemonOnline('device-1', daemon);
        await manager.addSession('device-1', session1);
        await manager.addSession('device-1', session2);

        // daemon 下线
        await manager.setDaemonOffline('device-1');

        // 不变量验证: 不应存在 daemon 已下线但 session 仍在线的情况
        const sessionInfo1 = await manager.getSessionInfo('session-1');
        const sessionInfo2 = await manager.getSessionInfo('session-2');

        expect(sessionInfo1).toBeNull();
        expect(sessionInfo2).toBeNull();
      });
    });

    describe('3.2 数据一致性', () => {
      it('getSessionsByDevice 和 isSessionOnline 一致', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session = createSessionInfo({ sessionId: 'session-1' });

        await manager.setDaemonOnline('device-1', daemon);
        await manager.addSession('device-1', session);

        const sessions = await manager.getSessionsByDevice('device-1');
        for (const s of sessions) {
          expect(await manager.isSessionOnline(s.sessionId)).toBe(true);
        }
      });

      it('getOnlineDaemons 和 isDaemonOnline 一致', async () => {
        const daemon1 = createDaemonInfo({ deviceId: 'device-1' });
        const daemon2 = createDaemonInfo({ deviceId: 'device-2' });

        await manager.setDaemonOnline('device-1', daemon1);
        await manager.setDaemonOnline('device-2', daemon2);

        const daemons = await manager.getOnlineDaemons();
        for (const d of daemons) {
          expect(await manager.isDaemonOnline(d.deviceId)).toBe(true);
        }
      });

      it('getSessionCountsByProject 统计准确', async () => {
        const daemon = createDaemonInfo({ deviceId: 'device-1' });
        const session1 = createSessionInfo({
          sessionId: 'session-1',
          projectPath: '/project/a',
        });
        const session2 = createSessionInfo({
          sessionId: 'session-2',
          projectPath: '/project/a',
        });
        const session3 = createSessionInfo({
          sessionId: 'session-3',
          projectPath: '/project/b',
        });

        await manager.setDaemonOnline('device-1', daemon);
        await manager.addSession('device-1', session1);
        await manager.addSession('device-1', session2);
        await manager.addSession('device-1', session3);

        const counts = await manager.getSessionCountsByProject();

        expect(counts['/project/a']).toBe(2);
        expect(counts['/project/b']).toBe(1);
      });
    });
  });

  // =================== 4. 场景测试 ===================

  describe('4. 场景测试', () => {
    describe('4.1 正常启动流程', () => {
      it('ETerm 连接 → 打开 session → iOS 查询', async () => {
        // Step 1: ETerm 连接，发送 daemon:online
        const daemon = createDaemonInfo({ deviceId: 'eterm-1' });
        await manager.setDaemonOnline('eterm-1', daemon);
        expect(await manager.isDaemonOnline('eterm-1')).toBe(true);

        // Step 2: ETerm 打开 session，发送 sessionStart
        const session = createSessionInfo({
          sessionId: 'claude-session-1',
          projectPath: '/Users/test/myproject',
        });
        await manager.addSession('eterm-1', session);
        expect(await manager.isSessionOnline('claude-session-1')).toBe(true);

        // Step 3: iOS 订阅，查询 snapshot
        const snapshot = await manager.getSnapshot();

        // 验证 iOS 能看到 1 个在线 session
        expect(snapshot.daemons).toHaveLength(1);
        expect(snapshot.sessions['eterm-1']).toHaveLength(1);
        expect(snapshot.sessions['eterm-1'][0].sessionId).toBe(
          'claude-session-1',
        );
      });
    });

    describe('4.2 多 Daemon 场景', () => {
      it('多个 ETerm 同时在线', async () => {
        const daemon1 = createDaemonInfo({
          deviceId: 'eterm-1',
          deviceName: 'MacBook Pro',
        });
        const daemon2 = createDaemonInfo({
          deviceId: 'eterm-2',
          deviceName: 'Mac Mini',
        });

        await manager.setDaemonOnline('eterm-1', daemon1);
        await manager.setDaemonOnline('eterm-2', daemon2);

        // 每个 daemon 有不同的 sessions
        await manager.addSession(
          'eterm-1',
          createSessionInfo({ sessionId: 'session-1a' }),
        );
        await manager.addSession(
          'eterm-1',
          createSessionInfo({ sessionId: 'session-1b' }),
        );
        await manager.addSession(
          'eterm-2',
          createSessionInfo({ sessionId: 'session-2a' }),
        );

        // 验证隔离性
        const sessions1 = await manager.getSessionsByDevice('eterm-1');
        const sessions2 = await manager.getSessionsByDevice('eterm-2');

        expect(sessions1).toHaveLength(2);
        expect(sessions2).toHaveLength(1);

        // 一个 daemon 下线不影响另一个
        await manager.setDaemonOffline('eterm-1');

        expect(await manager.isDaemonOnline('eterm-1')).toBe(false);
        expect(await manager.isDaemonOnline('eterm-2')).toBe(true);
        expect(await manager.isSessionOnline('session-1a')).toBe(false);
        expect(await manager.isSessionOnline('session-2a')).toBe(true);
      });
    });

    describe('4.3 断线重连场景', () => {
      it('daemon 重连后 sessions 被清空（全量覆盖策略）', async () => {
        const daemon = createDaemonInfo({ deviceId: 'eterm-1' });

        // 第一次上线
        await manager.setDaemonOnline('eterm-1', daemon);
        await manager.addSession(
          'eterm-1',
          createSessionInfo({ sessionId: 'session-1' }),
        );
        await manager.addSession(
          'eterm-1',
          createSessionInfo({ sessionId: 'session-2' }),
        );

        expect(await manager.isSessionOnline('session-1')).toBe(true);
        expect(await manager.isSessionOnline('session-2')).toBe(true);

        // 重连（模拟网络断开后重新连接）
        const result = await manager.setDaemonOnline('eterm-1', daemon);
        expect(result.isReconnect).toBe(true);

        // 旧的 sessions 应该被清除
        expect(await manager.isSessionOnline('session-1')).toBe(false);
        expect(await manager.isSessionOnline('session-2')).toBe(false);

        // 重新添加 sessions
        await manager.addSession(
          'eterm-1',
          createSessionInfo({ sessionId: 'session-3' }),
        );
        expect(await manager.isSessionOnline('session-3')).toBe(true);
      });
    });

    describe('4.4 Session 生命周期', () => {
      it('session 可以正常添加和移除', async () => {
        const daemon = createDaemonInfo({ deviceId: 'eterm-1' });
        await manager.setDaemonOnline('eterm-1', daemon);

        // 添加多个 sessions
        await manager.addSession(
          'eterm-1',
          createSessionInfo({ sessionId: 'session-1' }),
        );
        await manager.addSession(
          'eterm-1',
          createSessionInfo({ sessionId: 'session-2' }),
        );
        await manager.addSession(
          'eterm-1',
          createSessionInfo({ sessionId: 'session-3' }),
        );

        expect((await manager.getSessionsByDevice('eterm-1')).length).toBe(3);

        // 关闭一个 session
        await manager.removeSession('eterm-1', 'session-2');

        const sessions = await manager.getSessionsByDevice('eterm-1');
        expect(sessions.length).toBe(2);
        expect(sessions.map((s) => s.sessionId)).not.toContain('session-2');
      });
    });

    describe('4.5 边界情况', () => {
      it('对不存在的 daemon 查询返回 null/空', async () => {
        expect(await manager.getDaemonInfo('non-existent')).toBeNull();
        expect(await manager.getSessionsByDevice('non-existent')).toEqual([]);
        expect(await manager.isDaemonOnline('non-existent')).toBe(false);
      });

      it('对不存在的 session 查询返回 null/false', async () => {
        expect(await manager.getSessionInfo('non-existent')).toBeNull();
        expect(await manager.isSessionOnline('non-existent')).toBe(false);
      });

      it('空 deviceId 不影响系统稳定性', async () => {
        // 虽然空 deviceId 不是合法输入，但不应导致崩溃
        const daemon = createDaemonInfo({ deviceId: '' });
        await expect(manager.setDaemonOnline('', daemon)).resolves.toBeDefined();
      });
    });
  });
});

// =================== Bug 验证测试 ===================

describe('Bug 验证测试', () => {
  let manager: IStatusManager;

  beforeEach(async () => {
    manager = new MemoryStatusManager();
    await manager.init();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  describe('Bug #2: setDaemonOnline 不应无条件清空 sessions', () => {
    it('新 daemon 上线时可以清空（因为本来就没有）', async () => {
      const daemon = createDaemonInfo({ deviceId: 'device-1' });
      const result = await manager.setDaemonOnline('device-1', daemon);

      expect(result.isReconnect).toBe(false);
      expect(await manager.getSessionsByDevice('device-1')).toEqual([]);
    });

    it('重连时应清空旧 sessions（这是设计决策：全量覆盖）', async () => {
      // 这个测试验证当前的"全量覆盖"策略
      // 根据 PLAN，重连时清空是预期行为
      const daemon = createDaemonInfo({ deviceId: 'device-1' });
      const session = createSessionInfo({ sessionId: 'session-1' });

      await manager.setDaemonOnline('device-1', daemon);
      await manager.addSession('device-1', session);

      // 重连
      await manager.setDaemonOnline('device-1', daemon);

      // 旧 sessions 被清空是预期的
      expect(await manager.isSessionOnline('session-1')).toBe(false);
    });
  });

  describe('Bug #3: addSession 失败时的处理', () => {
    it('daemon 不存在时返回明确错误', async () => {
      const session = createSessionInfo({ sessionId: 'session-1' });

      const result = await manager.addSession('non-existent-device', session);

      // 应该返回明确的错误，而不是静默失败
      expect(result.success).toBe(false);
      expect(result.reason).toBe('daemon_not_found');
    });
  });
});
