/**
 * Vlaude 事件 Payload 类型定义
 *
 * 与 constants.ts 中的 @payload 注释保持同步
 */

// ==================== Daemon → Server Payloads ====================

export interface RegisterPayload {
  hostname: string;
  platform: string;
  version: string;
}

export interface OnlinePayload {
  timestamp: string;
}

export interface OfflinePayload {
  timestamp: string;
}

export interface HeartbeatPayload {
  timestamp: string;
  openSessions?: Array<{ sessionId: string; projectPath: string }>;
}

export interface SessionStartPayload {
  sessionId: string;
  projectPath: string;
  timestamp: string;
}

export interface SessionEndPayload {
  sessionId: string;
  timestamp: string;
}

export interface SessionAvailablePayload {
  sessionId: string;
  projectPath: string;
  timestamp: string;
}

export interface SessionUnavailablePayload {
  sessionId: string;
  timestamp: string;
}

export interface ProjectDataPayload {
  projects: unknown[];
  requestId?: string;
}

export interface SessionMetadataPayload {
  sessions: unknown[];
  projectPath?: string;
  requestId?: string;
}

export interface SessionMessagesPayload {
  sessionId: string;
  projectPath: string;
  messages: unknown[];
  total: number;
  hasMore: boolean;
  requestId?: string;
}

export interface SearchResultsPayload {
  results: unknown[];
  requestId?: string;
}

export interface NewMessagePayload {
  sessionId: string;
  message: unknown;
  timestamp: string;
}

export interface SessionUpdatePayload {
  sessionId: string;
  metadata: unknown;
}

export interface SessionListUpdatePayload {
  sessions: unknown[];
}

export interface ProjectUpdatePayload {
  projectPath: string;
  metadata?: unknown;
}

export interface ProjectListUpdatePayload {
  projects: unknown[];
}

export interface NewSessionFoundPayload {
  clientId: string;
  sessionId: string;
  projectPath: string;
  encodedDirName: string;
}

export interface NewSessionNotFoundPayload {
  clientId: string;
  projectPath: string;
}

export interface WatchStartedPayload {
  clientId: string;
  projectPath: string;
}

export interface NewSessionCreatedPayload {
  clientId: string;
  sessionId: string;
  projectPath: string;
}

export interface PermissionRequestPayload {
  requestId: string;
  sessionId: string;
  clientId: string;
  toolName: string;
  input: unknown;
  toolUseId: string;
  description: string;
}

export interface PermissionTimeoutPayload {
  requestId: string;
  sessionId: string;
  clientId: string;
}

export interface PermissionExpiredPayload {
  requestId: string;
  message: string;
}

export interface EtermOnlinePayload {
  deviceId: string;
  timestamp: string;
}

export interface EtermOfflinePayload {
  deviceId: string;
  timestamp: string;
}

export interface SwiftActivityPayload {
  sessionId: string;
  projectPath: string;
}

export interface SdkErrorPayload {
  sessionId: string;
  clientId: string;
  error: {
    type: string;
    message: string;
  };
}

export interface MetricsUpdatePayload {
  sessionId: string;
  metrics: unknown;
  timestamp: string;
}

export interface SessionDetailUpdatePayload {
  sessionId: string;
  projectPath: string;
}

export interface SessionRestoredPayload {
  sessionId: string;
  projectPath: string;
}

export interface SessionDeletedPayload {
  sessionId: string;
  projectPath: string;
}

export interface SessionCreatedResultPayload {
  success: boolean;
  sessionId?: string;
  error?: string;
  requestId?: string;
}

export interface CheckLoadingResultPayload {
  loading: boolean;
  requestId?: string;
}

export interface SendMessageResultPayload {
  success: boolean;
  error?: string;
  requestId?: string;
}

// ==================== Server → Daemon Payloads ====================

export interface RequestProjectDataPayload {
  limit?: number;
  requestId?: string;
}

export interface RequestSessionMetadataPayload {
  projectPath?: string;
  limit?: number;
  requestId?: string;
}

export interface RequestSessionMessagesPayload {
  sessionId: string;
  projectPath: string;
  limit: number;
  offset: number;
  order?: string;
  requestId?: string;
}

export interface RequestSearchPayload {
  query: string;
  projectPath?: string;
  requestId?: string;
}

export interface StartWatchingPayload {
  sessionId: string;
  projectPath: string;
}

export interface StopWatchingPayload {
  sessionId: string;
  projectPath: string;
}

export interface MobileViewingPayload {
  sessionId: string;
  isViewing: boolean;
}

export interface FindNewSessionPayload {
  clientId: string;
  projectPath: string;
}

export interface WatchNewSessionPayload {
  clientId: string;
  projectPath: string;
}

export interface SessionDiscoveredPayload {
  projectPath: string;
  sessionId: string;
}

export interface CreateSessionPayload {
  projectPath: string;
  requestId?: string;
}

export interface CreateSessionInEtermPayload {
  projectPath: string;
  requestId?: string;
}

export interface SendMessageToSessionPayload {
  sessionId: string;
  message: string;
  requestId?: string;
}

export interface CheckLoadingPayload {
  sessionId: string;
  requestId?: string;
}

export interface InjectToEtermPayload {
  sessionId: string;
  text: string;
}

export interface PermissionResponsePayload {
  requestId: string;
  sessionId: string;
  /** 响应动作: y=允许一次, n=拒绝, a=始终允许, 或自定义输入如 "n: 理由" */
  action: string;
  /** @deprecated 使用 action 代替 */
  approved?: boolean;
  /** @deprecated 使用 action 代替，如 "n: reason" */
  reason?: string;
}

export interface ResumeLocalPayload {
  sessionId: string;
}

export interface CommandPayload {
  command: string;
  data?: unknown;
}
