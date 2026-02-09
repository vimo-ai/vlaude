//! Socket 事件定义
//!
//! 定义 daemon 和 server 之间的所有事件
//!
//! 此文件是 Rust 端的事件名称定义
//! Server 端: vlaude/packages/vlaude-server/src/shared/events/constants.ts
//! Swift 端: ETerm/Plugins/VlaudeKit/Sources/VlaudeKit/Events/EventConstants.swift
//!
//! 修改事件名后运行 ./scripts/check-vlaude-events.sh 验证三端一致性

use serde::{Deserialize, Serialize};
use serde_json::Value;

// @event-registry-start

/// Daemon → Server 上行事件常量
#[allow(dead_code)]
pub mod daemon_events {
    // 连接生命周期
    /// @payload { hostname: String, platform: String, version: String }
    pub const REGISTER: &str = "daemon:register";
    /// @payload { success: bool }
    pub const REGISTERED: &str = "daemon:registered";
    /// @payload { timestamp: String }
    pub const ONLINE: &str = "daemon:online";
    /// @payload { timestamp: String }
    pub const OFFLINE: &str = "daemon:offline";
    /// @payload { timestamp: String, openSessions: Vec<SessionInfo> }
    pub const HEARTBEAT: &str = "daemon:heartbeat";

    // 会话生命周期
    /// @payload { sessionId: String, projectPath: String, timestamp: String }
    pub const SESSION_START: &str = "daemon:sessionStart";
    /// @payload { sessionId: String, timestamp: String }
    pub const SESSION_END: &str = "daemon:sessionEnd";
    /// @payload { sessionId: String, projectPath: String, timestamp: String }
    pub const SESSION_AVAILABLE: &str = "daemon:sessionAvailable";
    /// @payload { sessionId: String, timestamp: String }
    pub const SESSION_UNAVAILABLE: &str = "daemon:sessionUnavailable";

    // 数据响应
    /// @payload { projects: Vec<Project>, requestId: Option<String> }
    pub const PROJECT_DATA: &str = "daemon:projectData";
    /// @payload { sessions: Vec<Session>, projectPath: Option<String>, requestId: Option<String> }
    pub const SESSION_METADATA: &str = "daemon:sessionMetadata";
    /// @payload { sessionId: String, projectPath: String, messages: Vec<Message>, total: usize, hasMore: bool, requestId: Option<String> }
    pub const SESSION_MESSAGES: &str = "daemon:sessionMessages";
    /// @payload { results: Vec<SearchResult>, requestId: Option<String> }
    pub const SEARCH_RESULTS: &str = "daemon:searchResults";

    // 实时通知
    /// @payload { sessionId: String, message: Message, timestamp: String }
    pub const NEW_MESSAGE: &str = "daemon:newMessage";
    /// @payload { sessionId: String, metadata: SessionMetadata }
    pub const SESSION_UPDATE: &str = "daemon:sessionUpdate";
    /// @payload { sessions: Vec<SessionSummary> }
    pub const SESSION_LIST_UPDATE: &str = "daemon:sessionListUpdate";
    /// @payload { projectPath: String, metadata: Option<ProjectMetadata> }
    pub const PROJECT_UPDATE: &str = "daemon:projectUpdate";
    /// @payload { projects: Vec<ProjectSummary> }
    pub const PROJECT_LIST_UPDATE: &str = "daemon:projectListUpdate";

    // 新会话创建流程
    /// @payload { clientId: String, sessionId: String, projectPath: String, encodedDirName: String }
    pub const NEW_SESSION_FOUND: &str = "daemon:newSessionFound";
    /// @payload { clientId: String, projectPath: String }
    pub const NEW_SESSION_NOT_FOUND: &str = "daemon:newSessionNotFound";
    /// @payload { clientId: String, projectPath: String }
    pub const WATCH_STARTED: &str = "daemon:watchStarted";
    /// @payload { clientId: String, sessionId: String, projectPath: String }
    pub const NEW_SESSION_CREATED: &str = "daemon:newSessionCreated";

    // 权限请求
    /// @payload { requestId: String, sessionId: String, clientId: String, toolName: String, input: Value, toolUseId: String, description: String }
    pub const PERMISSION_REQUEST: &str = "daemon:permissionRequest";
    /// @payload { requestId: String, sessionId: String, clientId: String }
    pub const PERMISSION_TIMEOUT: &str = "daemon:permissionTimeout";
    /// @payload { requestId: String, message: String }
    pub const PERMISSION_EXPIRED: &str = "daemon:permissionExpired";
    /// @payload { toolUseId: String, sessionId: String, success: bool, message: Option<String> }
    pub const APPROVAL_ACK: &str = "daemon:approvalAck";

    // ETerm 状态
    /// @payload { deviceId: String, timestamp: String }
    pub const ETERM_ONLINE: &str = "daemon:etermOnline";
    /// @payload { deviceId: String, timestamp: String }
    pub const ETERM_OFFLINE: &str = "daemon:etermOffline";
    /// @payload { sessionId: String, projectPath: String }
    pub const SWIFT_ACTIVITY: &str = "daemon:swiftActivity";

    // 其他
    /// @payload { sessionId: String, clientId: String, error: SdkErrorInfo }
    pub const SDK_ERROR: &str = "daemon:sdkError";
    /// @payload { sessionId: String, metrics: Value, timestamp: String }
    pub const METRICS_UPDATE: &str = "daemon:metricsUpdate";
    /// @payload { sessionId: String, projectPath: String }
    pub const SESSION_DETAIL_UPDATE: &str = "daemon:sessionDetailUpdate";
    /// @payload { sessionId: String, projectPath: String }
    pub const SESSION_RESTORED: &str = "daemon:sessionRestored";
    /// @payload { sessionId: String, projectPath: String }
    pub const SESSION_DELETED: &str = "daemon:sessionDeleted";

    // 分段传输
    /// @payload { transferId: String, event: String, seq: usize, total: usize, data: String }
    pub const CHUNK: &str = "daemon:chunk";

    // 命令响应
    /// @payload { success: bool, sessionId: Option<String>, error: Option<String>, requestId: Option<String> }
    pub const SESSION_CREATED_RESULT: &str = "daemon:sessionCreatedResult";
    /// @payload { loading: bool, requestId: Option<String> }
    pub const CHECK_LOADING_RESULT: &str = "daemon:checkLoadingResult";
    /// @payload { success: bool, error: Option<String>, requestId: Option<String> }
    pub const SEND_MESSAGE_RESULT: &str = "daemon:sendMessageResult";
}

/// Server → Daemon 下行事件常量
#[allow(dead_code)]
pub mod server_events {
    // 数据请求
    /// @payload { limit: Option<usize>, requestId: Option<String> }
    pub const REQUEST_PROJECT_DATA: &str = "server:requestProjectData";
    /// @payload { projectPath: Option<String>, limit: Option<usize>, requestId: Option<String> }
    pub const REQUEST_SESSION_METADATA: &str = "server:requestSessionMetadata";
    /// @payload { sessionId: String, projectPath: String, limit: usize, offset: usize, order: Option<String>, requestId: Option<String> }
    pub const REQUEST_SESSION_MESSAGES: &str = "server:requestSessionMessages";
    /// @payload { query: String, projectPath: Option<String>, requestId: Option<String> }
    pub const REQUEST_SEARCH: &str = "server:requestSearch";

    // 会话监听
    /// @payload { sessionId: String, projectPath: String }
    pub const START_WATCHING: &str = "server:startWatching";
    /// @payload { sessionId: String, projectPath: String }
    pub const STOP_WATCHING: &str = "server:stopWatching";
    /// @payload { sessionId: String, isViewing: bool }
    pub const MOBILE_VIEWING: &str = "server:mobileViewing";

    // 会话创建
    /// @payload { clientId: String, projectPath: String }
    pub const FIND_NEW_SESSION: &str = "server:findNewSession";
    /// @payload { clientId: String, projectPath: String }
    pub const WATCH_NEW_SESSION: &str = "server:watchNewSession";
    /// @payload { projectPath: String, sessionId: String }
    pub const SESSION_DISCOVERED: &str = "server:sessionDiscovered";

    // 远程控制
    /// @payload { projectPath: String, requestId: Option<String> }
    pub const CREATE_SESSION: &str = "server:createSession";
    /// @payload { projectPath: String, requestId: Option<String> }
    pub const CREATE_SESSION_IN_ETERM: &str = "server:createSessionInEterm";
    /// @payload { sessionId: String, message: String, requestId: Option<String> }
    pub const SEND_MESSAGE: &str = "server:sendMessage";
    /// @payload { sessionId: String, requestId: Option<String> }
    pub const CHECK_LOADING: &str = "server:checkLoading";
    /// @payload { sessionId: String, text: String }
    pub const INJECT_TO_ETERM: &str = "server:injectToEterm";

    // 权限响应
    /// @payload { requestId: String, sessionId: String, action: String }
    /// action: y=允许一次, n=拒绝, a=始终允许, 或自定义输入如 "n: 理由"
    pub const PERMISSION_RESPONSE: &str = "server:permissionResponse";

    // iOS 客户端事件
    /// @payload { sessionId: String }
    pub const EXIT_REMOTE_ALLOWED: &str = "server:exitRemoteAllowed";
    /// @payload { sessionId: String, reason: String }
    pub const EXIT_REMOTE_DENIED: &str = "server:exitRemoteDenied";
    /// @payload { sessionId: String }
    pub const SESSION_CONFIRMED: &str = "server:sessionConfirmed";

    // 其他
    /// @payload { sessionId: String }
    pub const RESUME_LOCAL: &str = "server:resumeLocal";
    /// @payload { command: String, data: Option<Value> }
    pub const COMMAND: &str = "server:command";
    /// 无 payload
    pub const SERVER_SHUTDOWN: &str = "server-shutdown";
}

// @event-registry-end

// ==================== 上行事件 (Daemon → Server) ====================

/// Daemon 发送给 Server 的事件
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DaemonEvent {
    /// 注册 daemon
    #[serde(rename = "daemon:register")]
    Register(RegisterData),

    /// 上报在线状态
    #[serde(rename = "daemon:online")]
    Online(OnlineData),

    /// 上报离线状态
    #[serde(rename = "daemon:offline")]
    Offline(OfflineData),

    /// 上报项目数据
    #[serde(rename = "daemon:projectData")]
    ProjectData(ProjectDataPayload),

    /// 上报会话元数据
    #[serde(rename = "daemon:sessionMetadata")]
    SessionMetadata(SessionMetadataPayload),

    /// 上报会话可用
    #[serde(rename = "daemon:sessionAvailable")]
    SessionAvailable(SessionAvailableData),

    /// 上报会话不可用
    #[serde(rename = "daemon:sessionUnavailable")]
    SessionUnavailable(SessionUnavailableData),

    /// 上报新消息
    #[serde(rename = "daemon:newMessage")]
    NewMessage(NewMessageData),

    /// 上报 Metrics 更新
    #[serde(rename = "daemon:metricsUpdate")]
    MetricsUpdate(MetricsUpdateData),
}

// ==================== 下行事件 (Server → Daemon) ====================

/// Server 发送给 Daemon 的事件
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "event", content = "data")]
pub enum ServerEvent {
    /// 请求项目数据
    #[serde(rename = "server:requestProjectData")]
    RequestProjectData(RequestProjectDataPayload),

    /// 请求会话元数据
    #[serde(rename = "server:requestSessionMetadata")]
    RequestSessionMetadata(RequestSessionMetadataPayload),

    /// 请求会话消息
    #[serde(rename = "server:requestSessionMessages")]
    RequestSessionMessages(RequestMessagesPayload),

    /// 开始监听会话
    #[serde(rename = "server:startWatching")]
    StartWatching(WatchingPayload),

    /// 停止监听会话
    #[serde(rename = "server:stopWatching")]
    StopWatching(WatchingPayload),

    /// Mobile 查看状态变化
    #[serde(rename = "server:mobileViewing")]
    MobileViewing(MobileViewingPayload),

    /// 服务器关闭通知
    #[serde(rename = "server-shutdown")]
    ServerShutdown,
}

// ==================== 数据结构 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterData {
    pub hostname: String,
    pub platform: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineData {
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineData {
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDataPayload {
    pub projects: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadataPayload {
    pub sessions: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAvailableData {
    pub session_id: String,
    pub project_path: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUnavailableData {
    pub session_id: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMessageData {
    pub session_id: String,
    pub message: Value,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsUpdateData {
    pub session_id: String,
    pub metrics: Value,
    pub timestamp: String,
}

// ==================== Server → Daemon Payloads ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestProjectDataPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSessionMetadataPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestMessagesPayload {
    pub session_id: String,
    pub project_path: String,
    #[serde(default)]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchingPayload {
    pub session_id: String,
    pub project_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileViewingPayload {
    pub session_id: String,
    pub is_viewing: bool,
}

/// 会话消息响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessagesPayload {
    pub session_id: String,
    pub project_path: String,
    pub messages: Vec<serde_json::Value>,
    pub total: usize,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// 最新 Turn 是否未结束（turns_limit 模式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_turn: Option<bool>,
    /// 下次 loadMore 的游标（turns_limit 模式）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<usize>,
}

// ==================== 其他上行事件数据结构 ====================

/// 新会话发现通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionFoundData {
    pub client_id: String,
    pub session_id: String,
    pub project_path: String,
    pub encoded_dir_name: String,
}

/// 新会话未找到通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionNotFoundData {
    pub client_id: String,
    pub project_path: String,
}

/// 监听器已启动通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStartedData {
    pub client_id: String,
    pub project_path: String,
}

/// 新会话已创建通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionCreatedData {
    pub client_id: String,
    pub session_id: String,
    pub project_path: String,
}

/// 项目更新通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateData {
    pub project_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// 会话更新通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdateData {
    pub session_id: String,
    pub metadata: Value,
}

/// 会话详情更新通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetailUpdateData {
    pub session_id: String,
    pub project_path: String,
}

/// 会话恢复通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestoredData {
    pub session_id: String,
    pub project_path: String,
}

/// 会话删除通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletedData {
    pub session_id: String,
    pub project_path: String,
}

/// 权限请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestData {
    pub request_id: String,
    pub session_id: String,
    pub client_id: String,
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: String,
    pub description: String,
}

/// 权限超时通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalTimeoutData {
    pub request_id: String,
    pub session_id: String,
    pub client_id: String,
}

/// 权限过期通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalExpiredData {
    pub request_id: String,
    pub message: String,
}

/// SDK 错误通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkErrorData {
    pub session_id: String,
    pub client_id: String,
    pub error: SdkErrorInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdkErrorInfo {
    #[serde(rename = "type")]
    pub error_type: String,
    pub message: String,
}

/// Swift 活动通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwiftActivityData {
    pub session_id: String,
    pub project_path: String,
}

// ==================== 缺失的下行事件数据结构 ====================

/// 恢复本地模式
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeLocalPayload {
    pub session_id: String,
}

/// 监听新会话请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchNewSessionPayload {
    pub client_id: String,
    pub project_path: String,
}

/// 查找新会话请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindNewSessionPayload {
    pub client_id: String,
    pub project_path: String,
}

/// 会话发现通知
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiscoveredPayload {
    pub project_path: String,
    pub session_id: String,
}

/// 权限响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResponsePayload {
    pub request_id: String,
    pub approved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 服务器命令
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCommandPayload {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}
