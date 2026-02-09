//! 同步 API 模块
//!
//! 提供给 vlaude-ffi 调用的同步数据查询方法
//! 直接调用同步 DB 方法，不创建 Tokio Runtime（避免阻塞 FFI callback 所在的 tokio worker）

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

    // 初始化需要异步（connect_or_start_agent），创建一次性 runtime
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

// ==================== 同步数据查询 API（直接调 rusqlite，不创建 Runtime）====================

/// 列出项目（带统计信息）
pub fn list_projects(limit: usize, offset: usize) -> Result<Vec<ProjectWithStats>> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    client.list_projects_with_stats_sync(limit, offset)
}

/// 列出会话（按项目路径）
pub fn list_sessions(project_path: &str, limit: usize, offset: usize) -> Result<Vec<SessionWithProject>> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    client.list_sessions_by_project_path_sync(project_path, limit, offset)
}

/// 获取会话消息（DESC 顺序，最新的在前，供 iOS reversed 后正序显示）
pub fn get_messages(session_id: &str, limit: usize, offset: usize) -> Result<Vec<Message>> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    client.get_messages_ordered_sync(session_id, limit, offset, true)
}

/// 获取会话消息（带排序）
pub fn get_messages_ordered(session_id: &str, limit: usize, offset: usize, desc: bool) -> Result<Vec<Message>> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    client.get_messages_ordered_sync(session_id, limit, offset, desc)
}

/// 获取会话消息总数
pub fn get_message_count(session_id: &str) -> Result<i64> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    client.get_message_count_sync(session_id)
}

/// 全文搜索
pub fn search(query: &str, limit: usize) -> Result<Vec<SearchResult>> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    client.search_sync(query, limit)
}

/// 获取统计信息
pub fn get_stats() -> Result<Stats> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;
    client.get_stats_sync()
}

/// Turn-based 分页查询结果
pub struct TurnBasedResult {
    pub messages: Vec<serde_json::Value>,
    pub total: usize,
    pub has_more: bool,
    pub open_turn: bool,
    pub next_cursor: Option<usize>,
}

/// 按 Turn 数量获取会话消息
///
/// Turn = 从 user_text 到下一个 user_text 之前的所有消息
/// - `turns_limit`: 返回最近 N 个 Turn
/// - `before`: 只读取 index < before 的消息（用于翻页）
/// - `detail`: "summary"（裁剪大 payload）或 "full"（完整数据）
pub fn get_messages_by_turns(session_id: &str, turns_limit: usize, before: Option<usize>, detail: &str) -> Result<TurnBasedResult> {
    let client = get_agent_client().ok_or_else(|| anyhow::anyhow!("AgentClient not initialized"))?;

    let total = client.get_message_count_sync(session_id)? as usize;
    let is_first_page = before.is_none();
    let end_index = before.unwrap_or(total);

    // 首页：从末尾读取一批（每 turn 约 30 条，多留余量），避免全量读取
    // 翻页：读取 [0, before) 范围（before 通常远小于 total）
    let (read_offset, read_limit) = if is_first_page {
        let batch = std::cmp::min(turns_limit.saturating_mul(40).max(100), end_index);
        (end_index.saturating_sub(batch), batch)
    } else {
        (0, end_index)
    };

    let db_messages = client.get_messages_ordered_sync(session_id, read_limit, read_offset, false)?;

    let mut all_messages: Vec<serde_json::Value> = db_messages
        .into_iter()
        .filter_map(|msg| msg.raw.as_ref().and_then(|raw| serde_json::from_str(raw).ok()))
        .collect();
    crate::enrich_messages_with_content_blocks(&mut all_messages);

    // openTurn: 第一页从末尾扫描判断最后 turn 是否完成
    let open_turn = if is_first_page && !all_messages.is_empty() {
        !crate::is_last_turn_closed(&all_messages)
    } else {
        false
    };

    // 从末尾往前扫描，找到第 N 个 Turn 起点
    let mut turn_count = 0usize;
    let mut slice_start_local = 0usize;

    for i in (0..all_messages.len()).rev() {
        if crate::is_user_text(&all_messages[i]) {
            turn_count += 1;
            if turn_count > turns_limit {
                slice_start_local = i + 1;
                break;
            }
            slice_start_local = i;
        }
    }

    let mut result_messages = all_messages[slice_start_local..].to_vec();
    let absolute_start = read_offset + slice_start_local;
    let has_more = absolute_start > 0;
    let next_cursor = if has_more { Some(absolute_start) } else { None };

    // summary 模式裁剪大 payload
    if detail == "summary" {
        crate::content_blocks::trim_messages_for_summary(&mut result_messages);
    }

    Ok(TurnBasedResult {
        messages: result_messages,
        total,
        has_more,
        open_turn,
        next_cursor,
    })
}
