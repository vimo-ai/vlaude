//! Agent Client 适配器
//!
//! 封装 ai-cli-session-db 的 Agent Client，负责：
//! 1. 连接或启动 Agent（仅 RPC，不订阅事件）
//! 2. 直接读取本地 SessionDB（不通过 Agent）
//!
//! 架构说明（V2 读写分离）：
//! - Agent 负责 JSONL → DB 写入（避免多进程写冲突）
//! - 各端自行触发读，不依赖 Agent 事件推送
//! - Client 直接读取本地 DB（只读模式）

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info};

use ai_cli_session_db::{
    connect_or_start_agent, AgentClient, ClientConfig, DbConfig,
    Message, Project, ProjectWithStats, SearchResult, Session, SessionDB, SessionWithProject,
};

/// Agent Client 适配器
///
/// 封装 AgentClient + SessionDB 的组合：
/// - AgentClient: RPC 连接（notify_file_change 等），不订阅事件
/// - SessionDB: 直接读取本地数据库（只读模式）
pub struct AgentClientAdapter {
    /// Agent Client（仅 RPC 连接）
    agent_client: Arc<RwLock<AgentClient>>,
    /// 本地数据库连接（只读）
    db: Arc<RwLock<SessionDB>>,
    /// 组件名称
    component: String,
}

impl AgentClientAdapter {
    /// 创建适配器并连接 Agent
    ///
    /// - `component`: 组件名称
    /// - `db_path`: 数据库路径（可选，默认 ~/.vimo/db/ai-cli-session.db）
    /// - `agent_source_dir`: Agent 源目录（可选，用于首次部署 vimo-agent）
    pub async fn new(
        component: &str,
        db_path: Option<PathBuf>,
        agent_source_dir: Option<PathBuf>,
    ) -> anyhow::Result<Self> {
        let db_path = db_path.unwrap_or_else(|| {
            let vimo_root = std::env::var("VIMO_HOME").unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_default();
                format!("{}/.vimo", home)
            });
            PathBuf::from(format!("{}/db/ai-cli-session.db", vimo_root))
        });

        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        info!("[AgentClient] Connecting to Agent (component={})", component);

        // 1. 连接或启动 Agent
        let mut config = ClientConfig::new(component);
        if let Some(dir) = agent_source_dir {
            config.agent_source_dir = Some(dir);
        }
        let agent_client = connect_or_start_agent(config).await?;
        // [V2] 不再订阅事件，仅保留 RPC 连接

        // 2. 打开本地数据库（只读模式）
        info!("[AgentClient] Opening local database: {:?}", db_path);
        let db_config = DbConfig::local(db_path.to_string_lossy().into_owned());
        let db = SessionDB::connect(db_config)?;

        Ok(Self {
            agent_client: Arc::new(RwLock::new(agent_client)),
            db: Arc::new(RwLock::new(db)),
            component: component.to_string(),
        })
    }

    /// 通知 Agent 文件变化（增强实时性）
    pub async fn notify_file_change(&self, path: PathBuf) -> anyhow::Result<()> {
        let mut client = self.agent_client.write().await;
        client.notify_file_change(path).await?;
        Ok(())
    }

    // ==================== 数据查询 API（直接读取本地 DB）====================

    /// 按会话 ID 获取消息
    pub async fn get_messages(
        &self,
        session_id: &str,
        limit: usize,
        offset: usize,
    ) -> anyhow::Result<Vec<Message>> {
        let db = self.db.read().await;
        Ok(db.list_messages(session_id, limit, offset)?)
    }

    /// 按会话 ID 获取消息（支持排序）
    pub async fn get_messages_ordered(
        &self,
        session_id: &str,
        limit: usize,
        offset: usize,
        desc: bool,
    ) -> anyhow::Result<Vec<Message>> {
        let db = self.db.read().await;
        Ok(db.list_messages_ordered(session_id, limit, offset, desc)?)
    }

    /// 获取会话消息总数
    pub async fn get_message_count(&self, session_id: &str) -> anyhow::Result<i64> {
        let db = self.db.read().await;
        Ok(db.get_session_message_count(session_id)?)
    }

    /// 列出项目（带统计信息，支持分页）
    pub async fn list_projects_with_stats(&self, limit: usize, offset: usize) -> anyhow::Result<Vec<ProjectWithStats>> {
        let db = self.db.read().await;
        Ok(db.list_projects_with_stats(limit, offset)?)
    }

    /// 列出会话
    pub async fn list_sessions(&self, project_id: i64) -> anyhow::Result<Vec<Session>> {
        let db = self.db.read().await;
        Ok(db.list_sessions(project_id)?)
    }

    /// 根据路径获取项目
    pub async fn get_project_by_path(&self, path: &str) -> anyhow::Result<Option<Project>> {
        let db = self.db.read().await;
        Ok(db.get_project_by_path(path)?)
    }

    /// 根据项目路径列出会话（带项目信息，支持分页）
    pub async fn list_sessions_by_project_path(&self, project_path: &str, limit: usize, offset: usize) -> anyhow::Result<Vec<SessionWithProject>> {
        let db = self.db.read().await;
        Ok(db.list_sessions_by_project_path(project_path, limit, offset)?)
    }

    /// FTS 搜索
    pub async fn search(&self, query: &str, limit: usize) -> anyhow::Result<Vec<SearchResult>> {
        let db = self.db.read().await;
        Ok(db.search_fts(query, limit)?)
    }

    /// 获取统计信息
    pub async fn get_stats(&self) -> anyhow::Result<ai_cli_session_db::Stats> {
        let db = self.db.read().await;
        Ok(db.get_stats()?)
    }
}

impl Drop for AgentClientAdapter {
    fn drop(&mut self) {
        debug!("[AgentClient] Adapter dropped (component={})", self.component);
    }
}
