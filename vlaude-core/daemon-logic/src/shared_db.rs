//! 共享数据库集成
//!
//! 可选集成 claude-session-db，实现与 Memex/ETerm 数据共享

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use claude_session_db::{
    coordination::{Role, WriterHealth, WriterType},
    db::MessageInput,
    DbConfig, Message, Project, SearchResult, Session, SessionDB,
};

/// 共享数据库适配器（Vlaude 版本）
///
/// 与 Memex 共享同一数据库，实现：
/// - 本地缓存查询（避免重复扫描）
/// - Writer 协调（让出写入权给更高优先级的组件）
pub struct SharedDbAdapter {
    db: Arc<RwLock<SessionDB>>,
    role: Arc<RwLock<Role>>,
    heartbeat_cancel: Arc<RwLock<bool>>,
    heartbeat_handle: Arc<RwLock<Option<JoinHandle<()>>>>,
}

impl SharedDbAdapter {
    /// 创建适配器
    pub fn new(shared_db_path: Option<PathBuf>) -> anyhow::Result<Self> {
        let db_path = shared_db_path.unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_default();
            PathBuf::from(format!("{}/.eterm/session.db", home))
        });

        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        info!("[SharedDB] 连接共享数据库: {:?}", db_path);
        let config = DbConfig::local(db_path.to_string_lossy().into_owned());
        let db = SessionDB::connect(config)?;

        Ok(Self {
            db: Arc::new(RwLock::new(db)),
            role: Arc::new(RwLock::new(Role::Reader)),
            heartbeat_cancel: Arc::new(RwLock::new(false)),
            heartbeat_handle: Arc::new(RwLock::new(None)),
        })
    }

    /// 注册为 Writer
    pub async fn register(&self) -> anyhow::Result<Role> {
        // 重置取消标志
        *self.heartbeat_cancel.write().await = false;

        let mut db = self.db.write().await;
        let role = db.register_writer(WriterType::VlaudeDaemon)?;
        drop(db);

        *self.role.write().await = role;

        if role == Role::Writer {
            info!("[SharedDB] 成为 Writer，启动心跳");
            self.start_heartbeat().await;
        } else {
            info!("[SharedDB] 成为 Reader（已有其他 Writer）");
        }

        Ok(role)
    }

    async fn start_heartbeat(&self) {
        // 先停止已有的心跳任务
        self.stop_heartbeat().await;

        // 重置取消标志（stop_heartbeat 会设为 true）
        *self.heartbeat_cancel.write().await = false;

        let db = self.db.clone();
        let role = self.role.clone();
        let cancel = self.heartbeat_cancel.clone();

        let handle = tokio::spawn(async move {
            let interval = tokio::time::Duration::from_secs(10);

            loop {
                tokio::time::sleep(interval).await;

                if *cancel.read().await {
                    debug!("[SharedDB] 心跳任务收到取消信号");
                    break;
                }

                // 使用 write 锁，因为 heartbeat 可能修改内部状态
                let db_guard = db.write().await;
                match db_guard.heartbeat() {
                    Ok(()) => {
                        debug!("[SharedDB] 心跳成功");
                    }
                    Err(e) => {
                        warn!("[SharedDB] 心跳失败: {}", e);
                        drop(db_guard);
                        *role.write().await = Role::Reader;
                        break;
                    }
                }
            }
        });

        *self.heartbeat_handle.write().await = Some(handle);
    }

    async fn stop_heartbeat(&self) {
        *self.heartbeat_cancel.write().await = true;

        if let Some(handle) = self.heartbeat_handle.write().await.take() {
            handle.abort();
        }
    }

    /// 释放 Writer
    pub async fn release(&self) -> anyhow::Result<()> {
        self.stop_heartbeat().await;

        // 使用 write 锁
        let db = self.db.write().await;
        db.release_writer()?;
        drop(db);

        *self.role.write().await = Role::Reader;
        info!("[SharedDB] 已释放 Writer");
        Ok(())
    }

    /// 获取角色
    pub async fn role(&self) -> Role {
        *self.role.read().await
    }

    /// 是否为 Writer
    pub async fn is_writer(&self) -> bool {
        *self.role.read().await == Role::Writer
    }

    /// 检查 Writer 健康
    pub async fn check_writer_health(&self) -> anyhow::Result<WriterHealth> {
        let db = self.db.read().await;
        Ok(db.check_writer_health()?)
    }

    /// 尝试接管
    pub async fn try_takeover(&self) -> anyhow::Result<bool> {
        // 重置取消标志
        *self.heartbeat_cancel.write().await = false;

        let mut db = self.db.write().await;
        let taken = db.try_takeover()?;

        if taken {
            drop(db);
            *self.role.write().await = Role::Writer;
            self.start_heartbeat().await;
        }

        Ok(taken)
    }

    // ==================== 数据写入 API ====================

    /// 获取或创建项目
    pub async fn get_or_create_project(&self, name: &str, path: &str, source: &str) -> anyhow::Result<i64> {
        let db = self.db.write().await;
        Ok(db.get_or_create_project(name, path, source)?)
    }

    /// Upsert 会话
    pub async fn upsert_session(&self, session_id: &str, project_id: i64) -> anyhow::Result<()> {
        let db = self.db.write().await;
        Ok(db.upsert_session(session_id, project_id)?)
    }

    /// 批量插入消息
    pub async fn insert_messages(&self, session_id: &str, messages: &[MessageInput]) -> anyhow::Result<usize> {
        let db = self.db.write().await;
        Ok(db.insert_messages(session_id, messages)?)
    }

    // ==================== 数据查询 API ====================

    /// 按会话 ID 获取消息（优先从共享 DB 查询）
    pub async fn get_messages(
        &self,
        session_id: &str,
        limit: usize,
        offset: usize,
    ) -> anyhow::Result<Vec<Message>> {
        let db = self.db.read().await;
        Ok(db.list_messages(session_id, limit, offset)?)
    }

    /// 列出项目
    pub async fn list_projects(&self) -> anyhow::Result<Vec<Project>> {
        let db = self.db.read().await;
        Ok(db.list_projects()?)
    }

    /// 列出会话
    pub async fn list_sessions(&self, project_id: i64) -> anyhow::Result<Vec<Session>> {
        let db = self.db.read().await;
        Ok(db.list_sessions(project_id)?)
    }

    /// FTS 搜索
    pub async fn search(&self, query: &str, limit: usize) -> anyhow::Result<Vec<SearchResult>> {
        let db = self.db.read().await;
        Ok(db.search_fts(query, limit)?)
    }

    /// 获取统计信息
    pub async fn get_stats(&self) -> anyhow::Result<claude_session_db::Stats> {
        let db = self.db.read().await;
        Ok(db.get_stats()?)
    }
}

impl Drop for SharedDbAdapter {
    fn drop(&mut self) {
        // 尝试同步停止心跳（best effort）
        if let Ok(mut cancel) = self.heartbeat_cancel.try_write() {
            *cancel = true;
        }
        if let Ok(mut handle) = self.heartbeat_handle.try_write() {
            if let Some(h) = handle.take() {
                h.abort();
            }
        }
    }
}
