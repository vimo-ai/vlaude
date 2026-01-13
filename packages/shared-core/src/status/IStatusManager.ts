/**
 * 在线状态管理接口定义
 * @see PLAN_STATUS_MANAGER.md
 */

/**
 * Daemon 设备信息
 */
export interface DaemonInfo {
  deviceId: string;
  deviceName: string;
  platform: string;
  version: string;
  /** ISO 8601 格式时间戳 (JSON 序列化后为 string) */
  connectedAt: string;
}

/**
 * Session 信息
 */
export interface SessionInfo {
  sessionId: string;
  projectPath: string;
  terminalId?: number;
  /** ISO 8601 格式时间戳 (JSON 序列化后为 string) */
  startedAt: string;
}

/**
 * 状态快照（用于 iOS 首屏加载）
 */
export interface StatusSnapshot {
  daemons: DaemonInfo[];
  sessions: Record<string, SessionInfo[]>; // deviceId -> sessions
  sessionCounts: Record<string, number>; // projectPath -> count
  timestamp: number;
}

/**
 * 状态管理器配置
 */
export interface StatusManagerConfig {
  /** Redis 连接地址 */
  host?: string;
  /** Redis 端口 */
  port?: number;
  /** Redis 密码 */
  password?: string;
  /** Key 前缀，默认 'vlaude:status:' */
  keyPrefix?: string;
  /** TTL（秒），默认 60 */
  ttl?: number;
}

/**
 * 状态管理器接口
 * 提供 Redis 和 Memory 两种实现
 */
export interface IStatusManager {
  // =================== Daemon 状态 ===================

  /**
   * 标记 Daemon 上线
   * 如果是重连（deviceId 已存在），会先清除旧状态再设置新状态
   * 幂等：重复调用会覆盖旧状态
   */
  setDaemonOnline(
    deviceId: string,
    info: DaemonInfo,
  ): Promise<{
    isReconnect: boolean;
  }>;

  /**
   * 标记 Daemon 下线（同时清除其所有 Session）
   * 幂等：如果 deviceId 不存在，静默返回
   */
  setDaemonOffline(deviceId: string): Promise<void>;

  /**
   * 检查 Daemon 是否在线
   */
  isDaemonOnline(deviceId: string): Promise<boolean>;

  /**
   * 获取所有在线 Daemon
   */
  getOnlineDaemons(): Promise<DaemonInfo[]>;

  /**
   * 获取指定 Daemon 信息
   */
  getDaemonInfo(deviceId: string): Promise<DaemonInfo | null>;

  // =================== Session 状态 ===================

  /**
   * 添加在线 Session
   * 幂等：如果 sessionId 已存在，更新信息
   * 注意：如果 deviceId 不存在，返回 daemon_not_found
   */
  addSession(
    deviceId: string,
    session: SessionInfo,
  ): Promise<{
    success: boolean;
    reason?: 'added' | 'updated' | 'daemon_not_found';
  }>;

  /**
   * 移除在线 Session
   * 幂等：如果 sessionId 不存在，静默返回
   */
  removeSession(deviceId: string, sessionId: string): Promise<void>;

  /**
   * 获取指定 Daemon 的所有在线 Session
   */
  getSessionsByDevice(deviceId: string): Promise<SessionInfo[]>;

  /**
   * 获取每个项目的在线 Session 数量
   */
  getSessionCountsByProject(): Promise<Record<string, number>>;

  /**
   * 检查指定 Session 是否在线
   */
  isSessionOnline(sessionId: string): Promise<boolean>;

  /**
   * 获取指定 Session 的信息（包含所属 Daemon）
   */
  getSessionInfo(
    sessionId: string,
  ): Promise<{ session: SessionInfo; deviceId: string } | null>;

  // =================== 快照 ===================

  /**
   * 获取完整状态快照
   * iOS 订阅后应先调用此接口获取当前状态
   */
  getSnapshot(): Promise<StatusSnapshot>;

  // =================== 心跳 ===================

  /**
   * 更新 Daemon 心跳
   * Redis 模式：续期 TTL
   * Memory 模式：空操作
   */
  heartbeat(deviceId: string): Promise<void>;

  // =================== 生命周期 ===================

  /**
   * 初始化
   */
  init(): Promise<void>;

  /**
   * 销毁
   */
  destroy(): Promise<void>;
}
