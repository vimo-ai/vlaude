// Session
export { ClaudeSessionAR } from './session/ClaudeSessionAR';
export { ClaudeMessageEntity } from './session/ClaudeMessageEntity';
export { SessionStatus } from './session/SessionStatus';
export { IClaudeSessionBaseRepo } from './session/IClaudeSessionBaseRepo';

// Codec - 路径编码解码
export {
  encodeProjectPath,
  decodeProjectPath,
  getEncodedPrefix,
} from './codec/PathCodec';

// Parser - JSONL 解析
export {
  extractProjectPath,
  parseJsonlContent,
  parseJsonLine,
} from './parser/JsonlParser';

export {
  INTERNAL_MESSAGE_TYPES,
  isInternalMessage,
  filterInternalMessages,
  isSummaryEntry,
} from './parser/MessageFilter';

// Scanner - 项目/会话扫描
export {
  scanProjects,
  scanSessions,
  findEncodedDirName,
  findLatestSession,
  type ClaudeProjectInfo,
  type ClaudeSessionMeta,
} from './scanner/ProjectScanner';

export {
  readSessionMessages,
  readFirstLine,
  countFileLines,
  isSummaryFile,
  buildSessionPath,
  isValidSessionFile,
  extractSessionId,
  type SessionMessagesResult,
  type RawClaudeMessage,
  type TokenUsage,
} from './scanner/SessionReader';

// Registry - 服务注册中心
export {
  ServiceRegistry,
  type ServiceRegistryConfig,
  type ServiceEvent,
  type ServiceEventType,
  type ServiceInfo,
} from './registry/ServiceRegistry';
