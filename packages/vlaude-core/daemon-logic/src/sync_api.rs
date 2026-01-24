//! 同步 API 模块
//!
//! 提供给 vlaude-ffi 调用的同步数据查询方法
//! 内部使用 tokio runtime 执行异步操作

use crate::AgentClientAdapter;
use anyhow::Result;
use ai_cli_session_db::{Message, ProjectWithStats, SearchResult, SessionWithProject, Stats};
use std::sync::{Arc, OnceLock};
use tokio::runtime::Runtime;

/// 全局 Agent Client 适配器（懒初始化）
static AGENT_CLIENT: OnceLock<Arc<AgentClientAdapter>> = OnceLock::new();

/// 获取或初始化 Agent Client 适配器
pub fn get_agent_client() -> Option<&'static Arc<AgentClientAdapter>> {
    if AGENT_CLIENT.get().is_some() {
        return AGENT_CLIENT.get();
    }

    // 需要异步初始化，创建临时 runtime
    let rt = match Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!("[SyncAPI] Failed to create runtime: {}", e);
            return None;
        }
    };

    match rt.block_on(AgentClientAdapter::new("vlaude-ffi", None, None)) {
        Ok(adapter) => {
            let _ = AGENT_CLIENT.set(Arc::new(adapter));
            AGENT_CLIENT.get()
        }
        Err(e) => {
            tracing::error!("[SyncAPI] Failed to initialize AgentClientAdapter: {}", e);
            None
        }
    }
}

/// 创建临时 runtime
fn create_runtime() -> Result<Runtime> {
    Runtime::new().map_err(|e| anyhow::anyhow!("Failed to create runtime: {}", e))
}

// ==================== 同步数据查询 API ====================

/// 列出项目（带统计信息）
pub fn list_projects(limit: usize, offset: usize) -> Result<Vec<ProjectWithStats>> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(client.list_projects_with_stats(limit, offset))
}

/// 列出会话（按项目路径）
pub fn list_sessions(project_path: &str, limit: usize, offset: usize) -> Result<Vec<SessionWithProject>> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(client.list_sessions_by_project_path(project_path, limit, offset))
}

/// 获取会话消息（DESC 顺序，最新的在前，供 iOS reversed 后正序显示）
pub fn get_messages(session_id: &str, limit: usize, offset: usize) -> Result<Vec<Message>> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(client.get_messages_ordered(session_id, limit, offset, true))  // desc=true
}

/// 获取会话消息（带排序）
pub fn get_messages_ordered(session_id: &str, limit: usize, offset: usize, desc: bool) -> Result<Vec<Message>> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(client.get_messages_ordered(session_id, limit, offset, desc))
}

/// 获取会话消息总数
pub fn get_message_count(session_id: &str) -> Result<i64> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(client.get_message_count(session_id))
}

/// 全文搜索
pub fn search(query: &str, limit: usize) -> Result<Vec<SearchResult>> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(client.search(query, limit))
}

/// 获取统计信息
pub fn get_stats() -> Result<Stats> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(client.get_stats())
}
