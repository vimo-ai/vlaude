/**
 * Vlaude 事件常量定义
 *
 * 此文件是 Server 端的事件名称唯一真相源
 * Swift 端: ETerm/Plugins/VlaudeKit/Sources/VlaudeKit/Events/EventConstants.swift
 * Rust 端: vlaude/packages/vlaude-core/socket-client/src/events.rs
 *
 * 修改事件名后运行 ./scripts/check-vlaude-events.sh 验证三端一致性
 */

// @event-registry-start

/**
 * Daemon → Server 上行事件
 */
export const DaemonEvents = {
  // === 连接生命周期 ===
  /** @payload { hostname: string, platform: string, version: string } */
  REGISTER: 'daemon:register',
  /** @payload { success: boolean } */
  REGISTERED: 'daemon:registered',
  /** @payload { timestamp: string } */
  ONLINE: 'daemon:online',
  /** @payload { timestamp: string } */
  OFFLINE: 'daemon:offline',
  /** @payload { timestamp: string, openSessions?: Array<{ sessionId: string, projectPath: string }> } */
  HEARTBEAT: 'daemon:heartbeat',

  // === 会话生命周期 ===
  /** @payload { sessionId: string, projectPath: string, timestamp: string } */
  SESSION_START: 'daemon:sessionStart',
  /** @payload { sessionId: string, timestamp: string } */
  SESSION_END: 'daemon:sessionEnd',
  /** @payload { sessionId: string, projectPath: string, timestamp: string } */
  SESSION_AVAILABLE: 'daemon:sessionAvailable',
  /** @payload { sessionId: string, timestamp: string } */
  SESSION_UNAVAILABLE: 'daemon:sessionUnavailable',

  // === 数据响应 ===
  /** @payload { projects: Array<Project>, requestId?: string } */
  PROJECT_DATA: 'daemon:projectData',
  /** @payload { sessions: Array<Session>, projectPath?: string, requestId?: string } */
  SESSION_METADATA: 'daemon:sessionMetadata',
  /** @payload { sessionId: string, projectPath: string, messages: Array<Message>, total: number, hasMore: boolean, requestId?: string } */
  SESSION_MESSAGES: 'daemon:sessionMessages',
  /** @payload { results: Array<SearchResult>, requestId?: string } */
  SEARCH_RESULTS: 'daemon:searchResults',

  // === 实时通知 ===
  /** @payload { sessionId: string, message: Message, timestamp: string } */
  NEW_MESSAGE: 'daemon:newMessage',
  /** @payload { sessionId: string, metadata: SessionMetadata } */
  SESSION_UPDATE: 'daemon:sessionUpdate',
  /** @payload { sessions: Array<SessionSummary> } */
  SESSION_LIST_UPDATE: 'daemon:sessionListUpdate',
  /** @payload { projectPath: string, metadata?: ProjectMetadata } */
  PROJECT_UPDATE: 'daemon:projectUpdate',
  /** @payload { projects: Array<ProjectSummary> } */
  PROJECT_LIST_UPDATE: 'daemon:projectListUpdate',

  // === 新会话创建流程 ===
  /** @payload { clientId: string, sessionId: string, projectPath: string, encodedDirName: string } */
  NEW_SESSION_FOUND: 'daemon:newSessionFound',
  /** @payload { clientId: string, projectPath: string } */
  NEW_SESSION_NOT_FOUND: 'daemon:newSessionNotFound',
  /** @payload { clientId: string, projectPath: string } */
  WATCH_STARTED: 'daemon:watchStarted',
  /** @payload { clientId: string, sessionId: string, projectPath: string } */
  NEW_SESSION_CREATED: 'daemon:newSessionCreated',

  // === 权限请求 ===
  /** @payload { requestId: string, sessionId: string, clientId: string, toolName: string, input: any, toolUseId: string, description: string } */
  PERMISSION_REQUEST: 'daemon:permissionRequest',
  /** @payload { requestId: string, sessionId: string, clientId: string } */
  PERMISSION_TIMEOUT: 'daemon:permissionTimeout',
  /** @payload { requestId: string, message: string } */
  PERMISSION_EXPIRED: 'daemon:permissionExpired',
  /** @payload { toolUseId: string, sessionId: string, success: boolean, message?: string } */
  APPROVAL_ACK: 'daemon:approvalAck',

  // === ETerm 状态 ===
  /** @payload { deviceId: string, timestamp: string } */
  ETERM_ONLINE: 'daemon:etermOnline',
  /** @payload { deviceId: string, timestamp: string } */
  ETERM_OFFLINE: 'daemon:etermOffline',
  /** @payload { sessionId: string, projectPath: string } */
  SWIFT_ACTIVITY: 'daemon:swiftActivity',

  // === 其他 ===
  /** @payload { sessionId: string, clientId: string, error: { type: string, message: string } } */
  SDK_ERROR: 'daemon:sdkError',
  /** @payload { sessionId: string, metrics: Metrics, timestamp: string } */
  METRICS_UPDATE: 'daemon:metricsUpdate',
  /** @payload { sessionId: string, projectPath: string } */
  SESSION_DETAIL_UPDATE: 'daemon:sessionDetailUpdate',
  /** @payload { sessionId: string, projectPath: string } */
  SESSION_RESTORED: 'daemon:sessionRestored',
  /** @payload { sessionId: string, projectPath: string } */
  SESSION_DELETED: 'daemon:sessionDeleted',

  // === 命令响应 ===
  /** @payload { success: boolean, sessionId?: string, error?: string, requestId?: string } */
  SESSION_CREATED_RESULT: 'daemon:sessionCreatedResult',
  /** @payload { loading: boolean, requestId?: string } */
  CHECK_LOADING_RESULT: 'daemon:checkLoadingResult',
  /** @payload { success: boolean, error?: string, requestId?: string } */
  SEND_MESSAGE_RESULT: 'daemon:sendMessageResult',

  // === 分段传输 ===
  /** @payload { transferId: string, event: string, seq: number, total: number, data: string } */
  CHUNK: 'daemon:chunk',
} as const;

/**
 * Server → Daemon 下行事件
 */
export const ServerEvents = {
  // === 数据请求 ===
  /** @payload { limit?: number, requestId?: string } */
  REQUEST_PROJECT_DATA: 'server:requestProjectData',
  /** @payload { projectPath?: string, limit?: number, requestId?: string } */
  REQUEST_SESSION_METADATA: 'server:requestSessionMetadata',
  /** @payload { sessionId: string, projectPath: string, limit: number, offset: number, order?: string, requestId?: string } */
  REQUEST_SESSION_MESSAGES: 'server:requestSessionMessages',
  /** @payload { query: string, projectPath?: string, requestId?: string } */
  REQUEST_SEARCH: 'server:requestSearch',

  // === 会话监听 ===
  /** @payload { sessionId: string, projectPath: string } */
  START_WATCHING: 'server:startWatching',
  /** @payload { sessionId: string, projectPath: string } */
  STOP_WATCHING: 'server:stopWatching',
  /** @payload { sessionId: string, isViewing: boolean } */
  MOBILE_VIEWING: 'server:mobileViewing',

  // === 会话创建 ===
  /** @payload { clientId: string, projectPath: string } */
  FIND_NEW_SESSION: 'server:findNewSession',
  /** @payload { clientId: string, projectPath: string } */
  WATCH_NEW_SESSION: 'server:watchNewSession',
  /** @payload { projectPath: string, sessionId: string } */
  SESSION_DISCOVERED: 'server:sessionDiscovered',

  // === 远程控制 ===
  /** @payload { projectPath: string, requestId?: string } */
  CREATE_SESSION: 'server:createSession',
  /** @payload { projectPath: string, requestId?: string } */
  CREATE_SESSION_IN_ETERM: 'server:createSessionInEterm',
  /** @payload { sessionId: string, message: string, requestId?: string } */
  SEND_MESSAGE: 'server:sendMessage',
  /** @payload { sessionId: string, requestId?: string } */
  CHECK_LOADING: 'server:checkLoading',
  /** @payload { sessionId: string, text: string } */
  INJECT_TO_ETERM: 'server:injectToEterm',

  // === 权限响应 ===
  /** @payload { requestId: string, sessionId: string, action: string } */
  PERMISSION_RESPONSE: 'server:permissionResponse',

  // === iOS 客户端事件 ===
  /** @payload { sessionId: string } */
  EXIT_REMOTE_ALLOWED: 'server:exitRemoteAllowed',
  /** @payload { sessionId: string, reason: string } */
  EXIT_REMOTE_DENIED: 'server:exitRemoteDenied',
  /** @payload { sessionId: string } */
  SESSION_CONFIRMED: 'server:sessionConfirmed',

  // === 其他 ===
  /** @payload { sessionId: string } */
  RESUME_LOCAL: 'server:resumeLocal',
  /** @payload { command: string, data?: any } */
  COMMAND: 'server:command',
  /** 无 payload */
  SERVER_SHUTDOWN: 'server-shutdown',
} as const;

// @event-registry-end

// 类型导出
export type DaemonEventName = (typeof DaemonEvents)[keyof typeof DaemonEvents];
export type ServerEventName = (typeof ServerEvents)[keyof typeof ServerEvents];
