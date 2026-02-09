//! Daemon 业务逻辑层
//!
//! 整合 session-reader 和 socket-client，实现完整的 daemon 功能

mod agent_client;
mod content_blocks;
mod service;
mod watcher;
pub mod sync_api;

pub use content_blocks::{ContentBlock, parse_content_blocks, enrich_messages_with_content_blocks, trim_messages_for_summary};
pub use service::{
    DaemonService,
    ApprovalResult,
    MobileViewingCallback,
    ResumeLocalCallback,
    WatchNewSessionCallback,
    FindNewSessionCallback,
    SessionDiscoveredCallback,
    ServerCommandCallback,
    // ETerm 回调类型
    CreateSessionCallback,
    SendMessageCallback,
    CheckLoadingCallback,
    CreateSessionResult,
    SendMessageResult,
};

pub use watcher::{SessionWatcher, SessionWatchEvent};
pub use agent_client::AgentClientAdapter;
pub use service::is_user_text;
pub use service::is_last_turn_closed;
