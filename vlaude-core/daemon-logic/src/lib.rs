//! Daemon 业务逻辑层
//!
//! 整合 session-reader 和 socket-client，实现完整的 daemon 功能

mod service;
mod watcher;
mod shared_db;

pub use service::{
    DaemonService,
    ApprovalResult,
    MobileViewingCallback,
    ResumeLocalCallback,
    WatchNewSessionCallback,
    FindNewSessionCallback,
    SessionDiscoveredCallback,
    ServerCommandCallback,
};

pub use watcher::{SessionWatcher, SessionWatchEvent};
pub use shared_db::SharedDbAdapter;
