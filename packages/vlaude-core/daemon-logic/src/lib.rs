//! Daemon 业务逻辑层
//!
//! 整合 session-reader 和 socket-client，实现完整的 daemon 功能

mod content_blocks;
mod service;
mod watcher;
mod shared_db;
pub mod sync_api;

pub use content_blocks::{ContentBlock, parse_content_blocks, enrich_messages_with_content_blocks};
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
pub use shared_db::SharedDbAdapter;
