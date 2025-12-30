//! Socket 事件定义
//!
//! 定义 daemon 和 server 之间的所有事件

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
