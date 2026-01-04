//! Socket.IO 客户端模块
//!
//! 封装 rust_socketio 提供与 vlaude-server 的通信能力

mod client;
mod error;
mod events;
mod registry;

pub use client::{DaemonRegistration, SocketClient, SocketConfig, TlsConfig};
pub use error::SocketError;
pub use registry::{
    DaemonInfo, ServiceEvent, ServiceEventType, ServiceInfo, ServiceRegistry,
    ServiceRegistryConfig, SessionInfo,
};
pub use events::{
    // 上行事件数据
    RegisterData, OnlineData, OfflineData,
    ProjectDataPayload, SessionMetadataPayload, SessionMessagesPayload,
    SessionAvailableData, SessionUnavailableData,
    NewMessageData, MetricsUpdateData,
    // 其他上行事件数据
    NewSessionFoundData, NewSessionNotFoundData,
    WatchStartedData, NewSessionCreatedData, ProjectUpdateData, SessionUpdateData,
    SessionDetailUpdateData, SessionRestoredData, SessionDeletedData,
    ApprovalRequestData, ApprovalTimeoutData, ApprovalExpiredData,
    SdkErrorData, SdkErrorInfo, SwiftActivityData,
    // 下行事件数据
    RequestProjectDataPayload, RequestSessionMetadataPayload, RequestMessagesPayload,
    WatchingPayload, MobileViewingPayload,
    // 其他下行事件数据
    ResumeLocalPayload, WatchNewSessionPayload, FindNewSessionPayload,
    SessionDiscoveredPayload, ApprovalResponsePayload, ServerCommandPayload,
    // 事件枚举
    DaemonEvent, ServerEvent,
};
