//! Session Reader - Claude Code JSONL 数据读取层
//!
//! 提供对 ~/.claude/projects/ 目录的读取能力：
//! - 项目列表
//! - 会话列表
//! - 消息读取
//! - 文件监听

pub mod types;
pub mod claude;
pub mod watcher;

pub use types::*;
pub use claude::ClaudeReader;
pub use watcher::{FileWatcher, WatchEvent, WatchMode};
