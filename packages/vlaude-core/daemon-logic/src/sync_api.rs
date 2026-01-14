//! 同步 API 模块
//!
//! 提供给 vlaude-ffi 调用的同步数据查询方法
//! 内部使用 tokio runtime 执行异步操作

use crate::SharedDbAdapter;
use anyhow::Result;
use claude_session_db::{Message, ProjectWithStats, SearchResult, SessionWithProject, Stats};
use std::sync::{Arc, OnceLock};
use tokio::runtime::Runtime;

/// 全局共享数据库适配器（懒初始化）
static SHARED_DB: OnceLock<Arc<SharedDbAdapter>> = OnceLock::new();

/// 获取或初始化共享数据库适配器
pub fn get_shared_db() -> Option<&'static Arc<SharedDbAdapter>> {
    if SHARED_DB.get().is_some() {
        return SHARED_DB.get();
    }

    match SharedDbAdapter::new(None) {
        Ok(adapter) => {
            let _ = SHARED_DB.set(Arc::new(adapter));
            SHARED_DB.get()
        }
        Err(e) => {
            tracing::error!("[SyncAPI] Failed to initialize SharedDbAdapter: {}", e);
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
    let db = get_shared_db().ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(db.list_projects_with_stats(limit, offset))
}

/// 列出会话（按项目路径）
pub fn list_sessions(project_path: &str, limit: usize, offset: usize) -> Result<Vec<SessionWithProject>> {
    let db = get_shared_db().ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(db.list_sessions_by_project_path(project_path, limit, offset))
}

/// 获取会话消息（DESC 顺序，最新的在前，供 iOS reversed 后正序显示）
pub fn get_messages(session_id: &str, limit: usize, offset: usize) -> Result<Vec<Message>> {
    let db = get_shared_db().ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(db.get_messages_ordered(session_id, limit, offset, true))  // desc=true
}

/// 获取会话消息（带排序）
pub fn get_messages_ordered(session_id: &str, limit: usize, offset: usize, desc: bool) -> Result<Vec<Message>> {
    let db = get_shared_db().ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(db.get_messages_ordered(session_id, limit, offset, desc))
}

/// 获取会话消息总数
pub fn get_message_count(session_id: &str) -> Result<i64> {
    let db = get_shared_db().ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(db.get_message_count(session_id))
}

/// 全文搜索
pub fn search(query: &str, limit: usize) -> Result<Vec<SearchResult>> {
    let db = get_shared_db().ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(db.search(query, limit))
}

/// 获取统计信息
pub fn get_stats() -> Result<Stats> {
    let db = get_shared_db().ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;
    let rt = create_runtime()?;
    rt.block_on(db.get_stats())
}
