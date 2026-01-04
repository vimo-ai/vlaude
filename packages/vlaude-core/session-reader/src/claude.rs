//! Claude Code 数据读取器
//!
//! 薄封装 claude-session-db::SessionReader，提供 vlaude-core 专用的接口。
//! 所有业务逻辑在 claude-session-db 中实现，这里只做委托。

use std::path::PathBuf;

use claude_session_db::{
    IndexableSession, ParseResult, SessionMeta,
    SessionReader as DbSessionReader,
};

use crate::types::*;

/// Claude Code 数据读取器
///
/// 封装 claude-session-db::SessionReader，提供 vlaude-core 专用的接口。
pub struct ClaudeReader {
    inner: DbSessionReader,
}

impl ClaudeReader {
    /// 创建读取器
    pub fn new(projects_path: PathBuf) -> Self {
        Self {
            inner: DbSessionReader::new(projects_path),
        }
    }

    /// 使用默认路径创建读取器
    pub fn default() -> anyhow::Result<Self> {
        let home = std::env::var("HOME").map_err(|_| anyhow::anyhow!("无法获取 HOME 环境变量"))?;
        let projects_path = PathBuf::from(home).join(".claude/projects");
        Ok(Self::new(projects_path))
    }

    /// 从路径提取项目名
    pub fn extract_project_name(path: &str) -> String {
        DbSessionReader::extract_project_name(path)
    }

    /// 列出所有项目
    ///
    /// 会话数量不包含 agent session。
    pub fn list_projects(&mut self, limit: Option<usize>) -> anyhow::Result<Vec<ProjectInfo>> {
        let projects = self.inner.list_projects(limit);
        Ok(projects
            .into_iter()
            .map(|p| ProjectInfo {
                encoded_name: p.encoded_name,
                path: p.path,
                name: p.name,
                session_count: p.session_count,
                last_active: p.last_active,
            })
            .collect())
    }

    /// 列出项目下的所有会话
    ///
    /// # Arguments
    /// * `project_path` - 可选的项目路径过滤
    /// * `include_agents` - 是否包含 agent session (agent-xxx)
    pub fn list_sessions(
        &mut self,
        project_path: Option<&str>,
        include_agents: bool,
    ) -> anyhow::Result<Vec<SessionMeta>> {
        Ok(self.inner.list_sessions(project_path, include_agents))
    }

    /// 查找最新会话
    pub fn find_latest_session(
        &mut self,
        project_path: &str,
        within_seconds: Option<u64>,
    ) -> anyhow::Result<Option<SessionMeta>> {
        Ok(self.inner.find_latest_session(project_path, within_seconds))
    }

    /// 获取会话文件路径
    ///
    /// 通过 session_id 查询完整的文件路径。
    pub fn get_session_path(&mut self, session_id: &str) -> Option<String> {
        self.inner.get_session_path(session_id)
    }

    /// 获取编码后的目录名
    pub fn get_encoded_dir_name(&mut self, project_path: &str) -> Option<String> {
        self.inner.get_encoded_dir_name(project_path)
    }

    /// 读取会话消息（支持分页）
    pub fn read_messages(
        &self,
        session_path: &str,
        limit: usize,
        offset: usize,
        order: Order,
    ) -> anyhow::Result<MessagesResult> {
        let db_order = match order {
            Order::Asc => claude_session_db::Order::Asc,
            Order::Desc => claude_session_db::Order::Desc,
        };

        self.inner
            .read_messages(session_path, limit, offset, db_order)
            .ok_or_else(|| anyhow::anyhow!("无法读取会话消息"))
            .map(|r| MessagesResult {
                messages: r.messages,
                total: r.total,
                has_more: r.has_more,
            })
    }

    /// 读取原始 JSONL 消息（不做格式转换）
    pub fn read_messages_raw(
        &self,
        session_path: &str,
        limit: usize,
        offset: usize,
        order: Order,
    ) -> anyhow::Result<RawMessagesResult> {
        let db_order = match order {
            Order::Asc => claude_session_db::Order::Asc,
            Order::Desc => claude_session_db::Order::Desc,
        };

        self.inner
            .read_messages_raw(session_path, limit, offset, db_order)
            .ok_or_else(|| anyhow::anyhow!("无法读取会话消息"))
            .map(|r| RawMessagesResult {
                messages: r.messages,
                total: r.total,
                has_more: r.has_more,
            })
    }

    /// 解析完整会话
    pub fn parse_session(&self, meta: &SessionMeta) -> anyhow::Result<Option<ParseResult>> {
        Ok(self.inner.parse_session(meta))
    }

    /// 解析 JSONL 文件（用于索引）
    pub fn parse_session_from_path(&self, jsonl_path: &str) -> anyhow::Result<Option<IndexableSession>> {
        Ok(self.inner.parse_jsonl_for_index(jsonl_path))
    }

    /// 计算会话 Metrics
    pub fn calculate_metrics(&self, meta: &SessionMeta) -> anyhow::Result<Option<SessionMetrics>> {
        Ok(self
            .inner
            .calculate_metrics(meta)
            .map(|m| SessionMetrics {
                message_count: m.message_count,
                user_message_count: m.user_message_count,
                assistant_message_count: m.assistant_message_count,
                estimated_tokens: m.estimated_tokens,
                duration_seconds: m.duration_seconds,
            }))
    }
}
