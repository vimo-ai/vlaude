//! 领域类型定义
//!
//! session-reader 专用的类型。
//! 大部分类型从 claude-session-db 重导出。

use serde::Serialize;

// Re-export core types from claude-session-db
pub use claude_session_db::{
    IndexableMessage, IndexableSession, MessageType, ParsedMessage, ParseResult, SessionMeta,
    Source,
};

/// 排序方向
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    Asc,
    Desc,
}

/// 项目信息
#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    /// 编码后的目录名
    pub encoded_name: String,
    /// 解码后的真实路径
    pub path: String,
    /// 项目名称（从路径提取）
    pub name: String,
    /// 会话数量（不包含 agent session）
    pub session_count: usize,
    /// 最后活跃时间（毫秒时间戳）
    pub last_active: Option<u64>,
}

/// 消息读取结果
#[derive(Debug, Clone, Serialize)]
pub struct MessagesResult {
    pub messages: Vec<ParsedMessage>,
    pub total: usize,
    pub has_more: bool,
}

/// 原始消息读取结果（不做格式转换）
#[derive(Debug, Clone, Serialize)]
pub struct RawMessagesResult {
    pub messages: Vec<serde_json::Value>,
    pub total: usize,
    pub has_more: bool,
}

/// 会话 Metrics
#[derive(Debug, Clone, Serialize)]
pub struct SessionMetrics {
    /// 消息总数
    pub message_count: usize,
    /// 用户消息数
    pub user_message_count: usize,
    /// 助手消息数
    pub assistant_message_count: usize,
    /// 总 token 数（估算）
    pub estimated_tokens: usize,
    /// 会话时长（秒）
    pub duration_seconds: Option<u64>,
}
