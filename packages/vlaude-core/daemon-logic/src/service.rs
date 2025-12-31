//! Daemon 服务实现

use crate::watcher::{SessionWatcher, SessionWatchEvent};
use crate::SharedDbAdapter;
use anyhow::{bail, Result};
use session_reader::ClaudeReader;
use socket_client::{
    RegisterData, ServiceRegistry, ServiceRegistryConfig, SocketClient,
    SocketConfig, TlsConfig,
};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{oneshot, RwLock};
use tokio::time::Duration;
use tracing::{debug, error, info, warn};

/// 验证路径组件是否安全（防止路径穿越）
fn validate_path_component(s: &str, name: &str) -> Result<()> {
    if s.is_empty() {
        bail!("{} cannot be empty", name);
    }
    if s.contains("..") || s.starts_with('/') || s.contains('\0') {
        bail!("Invalid {}: contains forbidden characters", name);
    }
    Ok(())
}

/// Mobile 查看状态回调类型
pub type MobileViewingCallback = Arc<dyn Fn(&str, bool) + Send + Sync>;

/// 恢复本地模式回调类型
pub type ResumeLocalCallback = Arc<dyn Fn(&str) + Send + Sync>;

/// 监听新会话回调类型
pub type WatchNewSessionCallback = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// 查找新会话回调类型
pub type FindNewSessionCallback = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// 会话发现回调类型
pub type SessionDiscoveredCallback = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// 服务器命令回调类型
pub type ServerCommandCallback = Arc<dyn Fn(&str, Option<serde_json::Value>) + Send + Sync>;

/// 权限审批结果
#[derive(Debug, Clone)]
pub struct ApprovalResult {
    pub approved: bool,
    pub reason: Option<String>,
}

/// 等待中的权限请求
struct PendingApproval {
    tx: oneshot::Sender<ApprovalResult>,
}

/// Daemon 服务
pub struct DaemonService {
    /// Socket 客户端
    socket: Arc<RwLock<SocketClient>>,
    /// 会话读取器
    reader: Arc<RwLock<ClaudeReader>>,
    /// 正在监听的会话 ID 集合
    watching_sessions: Arc<RwLock<HashSet<String>>>,
    /// 设备信息
    hostname: String,
    /// TLS 配置
    tls_config: TlsConfig,
    /// 服务注册中心
    registry: Option<Arc<ServiceRegistry>>,
    /// 当前连接的 Server 地址
    current_server: Arc<RwLock<Option<String>>>,
    /// Mobile 查看状态回调
    mobile_viewing_callback: Arc<RwLock<Option<MobileViewingCallback>>>,
    /// 恢复本地模式回调
    resume_local_callback: Arc<RwLock<Option<ResumeLocalCallback>>>,
    /// 监听新会话回调
    watch_new_session_callback: Arc<RwLock<Option<WatchNewSessionCallback>>>,
    /// 查找新会话回调
    find_new_session_callback: Arc<RwLock<Option<FindNewSessionCallback>>>,
    /// 会话发现回调
    session_discovered_callback: Arc<RwLock<Option<SessionDiscoveredCallback>>>,
    /// 服务器命令回调
    server_command_callback: Arc<RwLock<Option<ServerCommandCallback>>>,
    /// 等待中的权限请求
    pending_approvals: Arc<RwLock<HashMap<String, PendingApproval>>>,
    /// 会话监听器
    session_watcher: Arc<SessionWatcher>,
    /// 共享数据库适配器
    shared_db: Option<Arc<SharedDbAdapter>>,
}

impl DaemonService {
    /// 创建服务
    pub fn new(socket_url: &str, hostname: &str) -> Result<Self> {
        Self::with_tls(socket_url, hostname, TlsConfig::default())
    }

    /// 创建服务（带 TLS 配置）
    pub fn with_tls(socket_url: &str, hostname: &str, tls: TlsConfig) -> Result<Self> {
        let config = SocketConfig {
            url: socket_url.to_string(),
            tls: tls.clone(),
            ..Default::default()
        };

        // 初始化共享数据库
        let shared_db = match SharedDbAdapter::new(None) {
            Ok(adapter) => {
                info!("[SharedDB] Connected to shared database");
                Some(Arc::new(adapter))
            }
            Err(e) => {
                warn!("[SharedDB] Failed to connect: {}, running without shared-db", e);
                None
            }
        };

        Ok(Self {
            socket: Arc::new(RwLock::new(SocketClient::new(config))),
            reader: Arc::new(RwLock::new(ClaudeReader::default()?)),
            watching_sessions: Arc::new(RwLock::new(HashSet::new())),
            hostname: hostname.to_string(),
            tls_config: tls,
            registry: None,
            current_server: Arc::new(RwLock::new(Some(socket_url.to_string()))),
            mobile_viewing_callback: Arc::new(RwLock::new(None)),
            resume_local_callback: Arc::new(RwLock::new(None)),
            watch_new_session_callback: Arc::new(RwLock::new(None)),
            find_new_session_callback: Arc::new(RwLock::new(None)),
            session_discovered_callback: Arc::new(RwLock::new(None)),
            server_command_callback: Arc::new(RwLock::new(None)),
            pending_approvals: Arc::new(RwLock::new(HashMap::new())),
            session_watcher: Arc::new(SessionWatcher::new()),
            shared_db,
        })
    }

    /// 使用 Redis 服务发现创建服务
    pub async fn with_registry(
        hostname: &str,
        tls: TlsConfig,
        redis_config: ServiceRegistryConfig,
    ) -> Result<Self> {
        info!("[ServiceDiscovery] Initializing Redis registry...");

        // 创建并连接 ServiceRegistry
        let registry = ServiceRegistry::new(redis_config)?;
        registry.connect().await?;

        // 启动事件监听
        registry.start_listening().await?;

        // 获取可用 Server 列表
        let servers = registry.get_servers().await?;
        info!("[ServiceDiscovery] Found {} servers: {:?}", servers.len(), servers);

        // 选择最高优先级的 Server
        let server_url = if let Some(addr) = servers.first() {
            format!("https://{}", addr)
        } else {
            // 从环境变量读取 fallback，默认 localhost:10005
            let host = std::env::var("VLAUDE_SERVER_HOST").unwrap_or_else(|_| "localhost".to_string());
            let port = std::env::var("VLAUDE_SERVER_PORT").unwrap_or_else(|_| "10005".to_string());
            warn!("[ServiceDiscovery] No servers found in Redis, using fallback: {}:{}", host, port);
            format!("https://{}:{}", host, port)
        };

        info!("[ServiceDiscovery] Selected server: {}", server_url);

        let config = SocketConfig {
            url: server_url.clone(),
            tls: tls.clone(),
            ..Default::default()
        };

        // 初始化共享数据库
        let shared_db = match SharedDbAdapter::new(None) {
            Ok(adapter) => {
                info!("[SharedDB] Connected to shared database");
                Some(Arc::new(adapter))
            }
            Err(e) => {
                warn!("[SharedDB] Failed to connect: {}, running without shared-db", e);
                None
            }
        };

        Ok(Self {
            socket: Arc::new(RwLock::new(SocketClient::new(config))),
            reader: Arc::new(RwLock::new(ClaudeReader::default()?)),
            watching_sessions: Arc::new(RwLock::new(HashSet::new())),
            hostname: hostname.to_string(),
            tls_config: tls,
            registry: Some(Arc::new(registry)),
            current_server: Arc::new(RwLock::new(Some(server_url))),
            mobile_viewing_callback: Arc::new(RwLock::new(None)),
            resume_local_callback: Arc::new(RwLock::new(None)),
            watch_new_session_callback: Arc::new(RwLock::new(None)),
            find_new_session_callback: Arc::new(RwLock::new(None)),
            session_discovered_callback: Arc::new(RwLock::new(None)),
            server_command_callback: Arc::new(RwLock::new(None)),
            pending_approvals: Arc::new(RwLock::new(HashMap::new())),
            session_watcher: Arc::new(SessionWatcher::new()),
            shared_db,
        })
    }

    /// 设置 Mobile 查看状态回调
    pub async fn set_mobile_viewing_callback(&self, callback: MobileViewingCallback) {
        *self.mobile_viewing_callback.write().await = Some(callback);
    }

    /// 设置恢复本地模式回调
    pub async fn set_resume_local_callback(&self, callback: ResumeLocalCallback) {
        *self.resume_local_callback.write().await = Some(callback);
    }

    /// 设置监听新会话回调
    pub async fn set_watch_new_session_callback(&self, callback: WatchNewSessionCallback) {
        *self.watch_new_session_callback.write().await = Some(callback);
    }

    /// 设置查找新会话回调
    pub async fn set_find_new_session_callback(&self, callback: FindNewSessionCallback) {
        *self.find_new_session_callback.write().await = Some(callback);
    }

    /// 设置会话发现回调
    pub async fn set_session_discovered_callback(&self, callback: SessionDiscoveredCallback) {
        *self.session_discovered_callback.write().await = Some(callback);
    }

    /// 设置服务器命令回调
    pub async fn set_server_command_callback(&self, callback: ServerCommandCallback) {
        *self.server_command_callback.write().await = Some(callback);
    }

    /// 启动服务
    pub async fn start(&self) -> Result<()> {
        info!("Starting daemon service...");

        // 注册共享数据库 Writer
        if let Some(db) = &self.shared_db {
            match db.register().await {
                Ok(role) => {
                    info!("[SharedDB] Registered as {:?}", role);
                }
                Err(e) => {
                    warn!("[SharedDB] Failed to register: {}", e);
                }
            }
        }

        // 连接到服务器
        self.socket.read().await.connect().await?;

        // 注册
        let register_data = RegisterData {
            hostname: self.hostname.clone(),
            platform: "darwin".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        };
        self.socket.read().await.register(register_data).await?;

        // 上报在线
        self.socket.read().await.report_online().await?;

        // 主动推送初始数据（让 Server 缓存到数据库）
        if let Err(e) = self.push_initial_data().await {
            warn!("Failed to push initial data: {:?}", e);
        }

        info!("Daemon service started");
        Ok(())
    }

    /// 主动推送初始数据到 Server（用于填充数据库缓存）
    async fn push_initial_data(&self) -> Result<()> {
        info!("Pushing initial data to server...");

        // 1. 推送项目列表
        let projects = self.reader.write().await.list_projects(Some(20))?;
        let projects_json: Vec<serde_json::Value> = projects
            .into_iter()
            .map(|p| serde_json::to_value(p).unwrap())
            .collect();

        info!("Pushing {} projects to server", projects_json.len());
        self.socket.read().await.report_project_data(projects_json, None).await?;

        // 2. 推送每个项目的会话列表（限制每个项目最多 50 个会话，避免消息过大）
        let all_sessions = self.reader.write().await.list_sessions(None)?;
        if !all_sessions.is_empty() {
            // 按 projectPath 分组
            let mut sessions_by_project: std::collections::HashMap<String, Vec<serde_json::Value>> =
                std::collections::HashMap::new();

            for session in all_sessions {
                let project_path = session.project_path.clone();
                let session_json = serde_json::to_value(&session).unwrap();
                let sessions = sessions_by_project.entry(project_path).or_default();
                // 限制每个项目最多 50 个会话
                if sessions.len() < 50 {
                    sessions.push(session_json);
                }
            }

            for (project_path, sessions) in sessions_by_project {
                info!(
                    "Pushing {} sessions for project {} to server",
                    sessions.len(),
                    project_path
                );
                self.socket.read().await
                    .report_session_metadata(sessions, Some(project_path), None)
                    .await?;
            }
        }

        info!("Initial data pushed successfully");
        Ok(())
    }

    /// 停止服务
    pub async fn stop(&self) {
        info!("Stopping daemon service...");

        // 释放共享数据库 Writer
        if let Some(db) = &self.shared_db {
            if let Err(e) = db.release().await {
                warn!("[SharedDB] Failed to release writer: {}", e);
            } else {
                info!("[SharedDB] Writer released");
            }
        }

        // 上报离线
        if let Err(e) = self.socket.read().await.report_offline().await {
            warn!("Failed to report offline: {:?}", e);
        }

        // 断开连接
        self.socket.read().await.disconnect().await;

        info!("Daemon service stopped");
    }

    /// 处理单个事件（非阻塞，带超时）
    pub async fn run_once(&self) -> Result<()> {
        // 检查会话文件更新
        if self.session_watcher.has_sessions().await {
            match self.session_watcher.check_updates().await {
                Ok(events) => {
                    for event in events {
                        if let Err(e) = self.handle_watch_event(event).await {
                            error!("Failed to handle watch event: {:?}", e);
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to check session updates: {:?}", e);
                }
            }
        }

        // 使用 recv_event_timeout 避免无限阻塞
        let socket = self.socket.read().await;
        match socket.recv_event_timeout(Duration::from_millis(100)).await {
            Some((event, data)) => {
                drop(socket); // 释放锁
                if let Err(e) = self.handle_event(&event, data).await {
                    error!("Failed to handle event {}: {:?}", event, e);
                }
            }
            None => {
                // 检查连接状态
                if !socket.is_connected() {
                    drop(socket); // 释放锁
                    warn!("Socket disconnected, attempting to reconnect...");
                    tokio::time::sleep(Duration::from_secs(5)).await;

                    let socket = self.socket.read().await;
                    if let Err(e) = socket.connect().await {
                        error!("Reconnect failed: {:?}", e);
                    } else {
                        // 重连成功后重新注册
                        let register_data = RegisterData {
                            hostname: self.hostname.clone(),
                            platform: "darwin".to_string(),
                            version: env!("CARGO_PKG_VERSION").to_string(),
                        };
                        let _ = socket.register(register_data).await;
                        let _ = socket.report_online().await;
                        info!("Reconnected and re-registered");
                    }
                }
            }
        }
        Ok(())
    }

    /// 处理会话监听事件
    async fn handle_watch_event(&self, event: SessionWatchEvent) -> Result<()> {
        match event {
            SessionWatchEvent::NewMessage {
                session_id,
                project_path,
                message,
            } => {
                debug!("New message in session {}", session_id);

                // 写入共享数据库（仅 Writer 模式）
                if let Some(db) = &self.shared_db {
                    if db.is_writer().await {
                        if let Err(e) = self.sync_message_to_shared_db(
                            db,
                            &session_id,
                            &project_path,
                            &message,
                        ).await {
                            warn!("[SharedDB] Failed to sync message: {}", e);
                        }
                    }
                }

                self.socket.read().await.notify_new_message(&session_id, message).await?;
            }
            SessionWatchEvent::SessionCreated {
                session_id,
                project_path,
            } => {
                info!("Session created: {}", session_id);
                self.socket.read().await
                    .notify_session_list_update(&project_path)
                    .await?;
            }
            SessionWatchEvent::SessionDeleted {
                session_id,
                project_path,
            } => {
                info!("Session deleted: {}", session_id);
                self.socket.read().await
                    .notify_session_deleted(&session_id, &project_path)
                    .await?;
            }
            SessionWatchEvent::Error { session_id, error } => {
                warn!("Session {} error: {}", session_id, error);
            }
        }
        Ok(())
    }

    /// 运行事件循环（阻塞版本，保留兼容性）
    pub async fn run(&self) -> Result<()> {
        loop {
            self.run_once().await?;
        }
    }

    /// 处理服务器事件
    async fn handle_event(&self, event: &str, data: serde_json::Value) -> Result<()> {
        debug!("Handling event: {} with data: {:?}", event, data);

        match event {
            "server:requestProjectData" => {
                self.handle_request_project_data(data).await?;
            }
            "server:requestSessionMetadata" => {
                self.handle_request_session_metadata(data).await?;
            }
            "server:requestSessionMessages" => {
                self.handle_request_session_messages(data).await?;
            }
            "server:startWatching" => {
                self.handle_start_watching(data).await?;
            }
            "server:stopWatching" => {
                self.handle_stop_watching(data).await?;
            }
            "server:mobileViewing" => {
                self.handle_mobile_viewing(data).await?;
            }
            "server:resumeLocal" => {
                self.handle_resume_local(data).await?;
            }
            "server:watchNewSession" => {
                self.handle_watch_new_session(data).await?;
            }
            "server:findNewSession" => {
                self.handle_find_new_session(data).await?;
            }
            "server:sessionDiscovered" => {
                self.handle_session_discovered(data).await?;
            }
            "server:approvalResponse" => {
                self.handle_approval_response(data).await?;
            }
            "server:command" => {
                self.handle_server_command(data).await?;
            }
            // V3: 写操作事件（从 HTTP API 改为 WebSocket）
            "server:createSession" => {
                self.handle_create_session(data).await?;
            }
            "server:checkLoading" => {
                self.handle_check_loading(data).await?;
            }
            "server:sendMessage" => {
                self.handle_send_message(data).await?;
            }
            "server-shutdown" => {
                warn!("Server is shutting down");
            }
            "__disconnected" => {
                warn!("Received disconnect event, will reconnect...");
                // 不在这里处理，run_once 会检测 is_connected 并重连
            }
            _ => {
                debug!("Unknown event: {}", event);
            }
        }

        Ok(())
    }

    // ==================== 事件处理器 ====================

    async fn handle_request_project_data(&self, data: serde_json::Value) -> Result<()> {
        let limit = data.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
        let request_id = data
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let projects = self.reader.write().await.list_projects(limit)?;

        let projects_json: Vec<serde_json::Value> = projects
            .into_iter()
            .map(|p| serde_json::to_value(p).unwrap())
            .collect();

        self.socket.read().await
            .report_project_data(projects_json, request_id)
            .await?;

        Ok(())
    }

    async fn handle_request_session_metadata(&self, data: serde_json::Value) -> Result<()> {
        let project_path = data.get("projectPath").and_then(|v| v.as_str());
        let request_id = data
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let sessions = self.reader.write().await.list_sessions(project_path)?;

        let sessions_json: Vec<serde_json::Value> = sessions
            .into_iter()
            .map(|s| serde_json::to_value(s).unwrap())
            .collect();

        self.socket.read().await
            .report_session_metadata(
                sessions_json,
                project_path.map(|s| s.to_string()),
                request_id,
            )
            .await?;

        Ok(())
    }

    async fn handle_request_session_messages(&self, data: serde_json::Value) -> Result<()> {
        let session_id = data
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let project_path = data
            .get("projectPath")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        validate_path_component(session_id, "session_id")?;

        let limit = data.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
        let offset = data.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let order_str = data.get("order").and_then(|v| v.as_str()).unwrap_or("asc");
        let request_id = data
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let order = if order_str == "desc" {
            session_reader::Order::Desc
        } else {
            session_reader::Order::Asc
        };

        // 构建会话文件路径
        let reader = self.reader.read().await;
        let encoded_dir = reader
            .get_encoded_dir_name(project_path)
            .unwrap_or_else(|| ClaudeReader::encode_path(project_path));

        let home = std::env::var("HOME").unwrap_or_default();
        let session_path = format!(
            "{}/.claude/projects/{}/{}.jsonl",
            home, encoded_dir, session_id
        );

        // 使用 read_messages_raw 返回原始 JSONL 格式，不做转换
        let result = reader.read_messages_raw(&session_path, limit, offset, order)?;

        let message_count = result.messages.len();

        self.socket.read().await
            .report_session_messages(
                session_id.to_string(),
                project_path.to_string(),
                result.messages,
                result.total,
                result.has_more,
                request_id,
            )
            .await?;

        debug!(
            "Sent {} messages for session {}",
            message_count,
            session_id
        );

        Ok(())
    }

    async fn handle_start_watching(&self, data: serde_json::Value) -> Result<()> {
        let session_id = data
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let project_path = data
            .get("projectPath")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        validate_path_component(session_id, "session_id")?;

        info!("Start watching session: {}", session_id);

        self.watching_sessions
            .write()
            .await
            .insert(session_id.to_string());

        let reader = self.reader.read().await;
        let encoded_dir = reader
            .get_encoded_dir_name(project_path)
            .unwrap_or_else(|| ClaudeReader::encode_path(project_path));

        let home = std::env::var("HOME").unwrap_or_default();
        let session_path = PathBuf::from(format!(
            "{}/.claude/projects/{}/{}.jsonl",
            home, encoded_dir, session_id
        ));

        self.session_watcher
            .watch_session(session_id, &session_path, project_path)
            .await?;

        Ok(())
    }

    async fn handle_stop_watching(&self, data: serde_json::Value) -> Result<()> {
        let session_id = data
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        info!("Stop watching session: {}", session_id);

        self.watching_sessions.write().await.remove(session_id);
        self.session_watcher.unwatch_session(session_id).await;

        Ok(())
    }

    async fn handle_mobile_viewing(&self, data: serde_json::Value) -> Result<()> {
        let session_id = data
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let is_viewing = data.get("isViewing").and_then(|v| v.as_bool()).unwrap_or(false);

        debug!(
            "Mobile viewing status for {}: {}",
            session_id, is_viewing
        );

        if let Some(callback) = self.mobile_viewing_callback.read().await.as_ref() {
            callback(session_id, is_viewing);
        }

        Ok(())
    }

    async fn handle_resume_local(&self, data: serde_json::Value) -> Result<()> {
        let session_id = data
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        info!("Resume local mode for session: {}", session_id);

        if let Some(callback) = self.resume_local_callback.read().await.as_ref() {
            callback(session_id);
        }

        Ok(())
    }

    async fn handle_watch_new_session(&self, data: serde_json::Value) -> Result<()> {
        let client_id = data
            .get("clientId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let project_path = data
            .get("projectPath")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        info!("Watch new session request: client={}, project={}", client_id, project_path);

        if let Some(callback) = self.watch_new_session_callback.read().await.as_ref() {
            callback(client_id, project_path);
        }

        Ok(())
    }

    async fn handle_find_new_session(&self, data: serde_json::Value) -> Result<()> {
        let client_id = data
            .get("clientId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let project_path = data
            .get("projectPath")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        info!("Find new session request: client={}, project={}", client_id, project_path);

        if let Some(callback) = self.find_new_session_callback.read().await.as_ref() {
            callback(client_id, project_path);
        }

        Ok(())
    }

    async fn handle_session_discovered(&self, data: serde_json::Value) -> Result<()> {
        let project_path = data
            .get("projectPath")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let session_id = data
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        info!("Session discovered: project={}, session={}", project_path, session_id);

        if let Some(callback) = self.session_discovered_callback.read().await.as_ref() {
            callback(project_path, session_id);
        }

        Ok(())
    }

    async fn handle_approval_response(&self, data: serde_json::Value) -> Result<()> {
        let request_id = data
            .get("requestId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let approved = data.get("approved").and_then(|v| v.as_bool()).unwrap_or(false);
        let reason = data.get("reason").and_then(|v| v.as_str()).map(|s| s.to_string());

        info!("Approval response: request={}, approved={}", request_id, approved);

        let mut pending = self.pending_approvals.write().await;
        if let Some(approval) = pending.remove(request_id) {
            let _ = approval.tx.send(ApprovalResult { approved, reason });
        } else {
            warn!("No pending approval found for request: {}", request_id);
            self.socket.read().await
                .send_approval_expired(request_id, "Request expired or not found")
                .await?;
        }

        Ok(())
    }

    async fn handle_server_command(&self, data: serde_json::Value) -> Result<()> {
        let command = data
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let cmd_data = data.get("data").cloned();

        info!("Server command: {}", command);

        if let Some(callback) = self.server_command_callback.read().await.as_ref() {
            callback(command, cmd_data);
        }

        Ok(())
    }

    // ==================== V3: 写操作处理方法 ====================

    /// 处理创建会话请求
    /// 注意：Daemon 本身不创建会话，需要通过 ETerm 或 CLI 创建
    async fn handle_create_session(&self, data: serde_json::Value) -> Result<()> {
        let request_id = data
            .get("requestId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let project_path = data
            .get("projectPath")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let prompt = data.get("prompt").and_then(|v| v.as_str());

        info!(
            "Create session request: request_id={}, project={}",
            request_id, project_path
        );

        // TODO: 实际的会话创建需要通过 ETerm 或启动 Claude CLI
        // 目前先返回失败，等待 ETerm 集成完成
        self.socket
            .read()
            .await
            .send_session_created_result(
                request_id,
                false,
                None,
                None,
                None,
                Some("Daemon does not support session creation directly. Please use ETerm."),
            )
            .await?;

        Ok(())
    }

    /// 处理检查加载状态请求
    async fn handle_check_loading(&self, data: serde_json::Value) -> Result<()> {
        let request_id = data
            .get("requestId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let session_id = data
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        info!(
            "Check loading request: request_id={}, session={}",
            request_id, session_id
        );

        // 目前返回 false（未加载），因为 Daemon 不跟踪加载状态
        // 实际的加载状态需要通过 SDK 或 ETerm 来获取
        self.socket
            .read()
            .await
            .send_check_loading_result(request_id, false)
            .await?;

        Ok(())
    }

    /// 处理发送消息请求
    /// 注意：Daemon 本身不发送消息，需要通过 ETerm 或 SDK 发送
    async fn handle_send_message(&self, data: serde_json::Value) -> Result<()> {
        let request_id = data
            .get("requestId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let session_id = data
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let text = data.get("text").and_then(|v| v.as_str()).unwrap_or_default();

        info!(
            "Send message request: request_id={}, session={}, text_len={}",
            request_id,
            session_id,
            text.len()
        );

        // TODO: 实际的消息发送需要通过 ETerm 或 SDK
        // 目前先返回失败，等待集成完成
        self.socket
            .read()
            .await
            .send_message_result(
                request_id,
                false,
                Some("Daemon does not support message sending directly. Please use ETerm."),
                None,
            )
            .await?;

        Ok(())
    }

    // ==================== 通知方法 ====================

    /// 通知找到新会话
    pub async fn notify_new_session_found(
        &self,
        client_id: &str,
        session_id: &str,
        project_path: &str,
        encoded_dir_name: &str,
    ) -> Result<()> {
        self.socket.read().await
            .notify_new_session_found(client_id, session_id, project_path, encoded_dir_name)
            .await?;
        Ok(())
    }

    /// 通知未找到新会话
    pub async fn notify_new_session_not_found(
        &self,
        client_id: &str,
        project_path: &str,
    ) -> Result<()> {
        self.socket.read().await
            .notify_new_session_not_found(client_id, project_path)
            .await?;
        Ok(())
    }

    /// 通知监听器已启动
    pub async fn notify_watch_started(
        &self,
        client_id: &str,
        project_path: &str,
    ) -> Result<()> {
        self.socket.read().await
            .notify_watch_started(client_id, project_path)
            .await?;
        Ok(())
    }

    /// 通知新会话已创建
    pub async fn notify_new_session_created(
        &self,
        client_id: &str,
        session_id: &str,
        project_path: &str,
    ) -> Result<()> {
        self.socket.read().await
            .notify_new_session_created(client_id, session_id, project_path)
            .await?;
        Ok(())
    }

    /// 通知项目更新
    pub async fn notify_project_update(
        &self,
        project_path: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<()> {
        self.socket.read().await
            .notify_project_update(project_path, metadata)
            .await?;
        Ok(())
    }

    /// 通知会话更新
    pub async fn notify_session_update(
        &self,
        session_id: &str,
        metadata: serde_json::Value,
    ) -> Result<()> {
        self.socket.read().await
            .notify_session_update(session_id, metadata)
            .await?;
        Ok(())
    }

    /// 通知项目列表更新
    pub async fn notify_project_list_update(&self) -> Result<()> {
        self.socket.read().await.notify_project_list_update().await?;
        Ok(())
    }

    /// 通知会话列表更新
    pub async fn notify_session_list_update(&self, project_path: &str) -> Result<()> {
        self.socket.read().await.notify_session_list_update(project_path).await?;
        Ok(())
    }

    /// 通知会话详情更新
    pub async fn notify_session_detail_update(
        &self,
        session_id: &str,
        project_path: &str,
    ) -> Result<()> {
        self.socket.read().await
            .notify_session_detail_update(session_id, project_path)
            .await?;
        Ok(())
    }

    /// 通知会话已恢复
    pub async fn notify_session_restored(
        &self,
        session_id: &str,
        project_path: &str,
    ) -> Result<()> {
        self.socket.read().await
            .notify_session_restored(session_id, project_path)
            .await?;
        Ok(())
    }

    /// 通知会话已删除
    pub async fn notify_session_deleted(
        &self,
        session_id: &str,
        project_path: &str,
    ) -> Result<()> {
        self.socket.read().await
            .notify_session_deleted(session_id, project_path)
            .await?;
        Ok(())
    }

    /// 通知新消息
    pub async fn notify_new_message(
        &self,
        session_id: &str,
        message: serde_json::Value,
    ) -> Result<()> {
        self.socket.read().await.notify_new_message(session_id, message).await?;
        Ok(())
    }

    /// 通知 Metrics 更新
    pub async fn notify_metrics_update(
        &self,
        session_id: &str,
        metrics: serde_json::Value,
    ) -> Result<()> {
        self.socket.read().await.notify_metrics_update(session_id, metrics).await?;
        Ok(())
    }

    // ==================== 权限审批 ====================

    /// 请求权限审批
    pub async fn request_approval(
        &self,
        session_id: &str,
        client_id: &str,
        tool_name: &str,
        input: serde_json::Value,
        tool_use_id: &str,
        timeout_ms: u64,
    ) -> Result<ApprovalResult> {
        let request_id = format!("{}-{}", session_id, tool_use_id);
        let description = format_tool_description(tool_name, &input);

        let (tx, rx) = oneshot::channel();

        self.pending_approvals.write().await.insert(
            request_id.clone(),
            PendingApproval { tx },
        );

        self.socket.read().await
            .send_approval_request(
                &request_id,
                session_id,
                client_id,
                tool_name,
                input,
                tool_use_id,
                &description,
            )
            .await?;

        let timeout = Duration::from_millis(timeout_ms);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => {
                self.pending_approvals.write().await.remove(&request_id);
                Ok(ApprovalResult {
                    approved: false,
                    reason: Some("Channel closed".to_string()),
                })
            }
            Err(_) => {
                self.pending_approvals.write().await.remove(&request_id);
                self.socket.read().await
                    .send_approval_timeout(&request_id, session_id, client_id)
                    .await?;
                Ok(ApprovalResult {
                    approved: false,
                    reason: Some("Request timeout".to_string()),
                })
            }
        }
    }

    /// 发送 SDK 错误
    pub async fn send_sdk_error(
        &self,
        session_id: &str,
        client_id: &str,
        error_type: &str,
        message: &str,
    ) -> Result<()> {
        self.socket.read().await
            .send_sdk_error(session_id, client_id, error_type, message)
            .await?;
        Ok(())
    }

    /// 发送 Swift 活动通知
    pub async fn send_swift_activity(
        &self,
        session_id: &str,
        project_path: &str,
    ) -> Result<()> {
        self.socket.read().await
            .send_swift_activity(session_id, project_path)
            .await?;
        Ok(())
    }

    /// 获取 Socket 客户端引用（异步）
    pub async fn socket(&self) -> tokio::sync::RwLockReadGuard<'_, SocketClient> {
        self.socket.read().await
    }

    /// 获取 Reader 引用
    pub fn reader(&self) -> &Arc<RwLock<ClaudeReader>> {
        &self.reader
    }
}

impl DaemonService {
    /// 同步单条消息到共享数据库
    async fn sync_message_to_shared_db(
        &self,
        db: &Arc<SharedDbAdapter>,
        session_id: &str,
        project_path: &str,
        message: &serde_json::Value,
    ) -> Result<()> {
        use claude_session_db::db::MessageInput;
        use claude_session_db::MessageType;

        // 提取项目名（路径最后一段）
        let project_name = project_path
            .split('/')
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or(project_path);

        // 获取或创建项目
        let project_id = db.get_or_create_project(project_name, project_path, "claude").await?;

        // 确保会话存在
        db.upsert_session(session_id, project_id).await?;

        // 从 JSON 提取消息字段
        let uuid = message.get("uuid")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        if uuid.is_empty() {
            // 没有 uuid 的消息跳过（可能是系统消息）
            return Ok(());
        }

        let type_str = message.get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("user");
        let msg_type = match type_str {
            "assistant" => MessageType::Assistant,
            _ => MessageType::User,
        };

        // 提取内容
        let content = if let Some(content) = message.get("message").and_then(|m| m.get("content")) {
            // Claude 格式：message.content 可能是数组或字符串
            if let Some(arr) = content.as_array() {
                arr.iter()
                    .filter_map(|item| {
                        item.get("text").and_then(|t| t.as_str())
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            } else if let Some(s) = content.as_str() {
                s.to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // 提取时间戳
        let timestamp = message.get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0)
            });

        // 保存原始 JSON
        let raw = serde_json::to_string(message).ok();

        let msg_input = MessageInput {
            uuid,
            r#type: msg_type,
            content,
            timestamp,
            sequence: 0,
            source: Some("claude".to_string()),
            channel: Some("code".to_string()),
            model: None,
            tool_call_id: None,
            tool_name: None,
            tool_args: None,
            raw,
        };

        let inserted = db.insert_messages(session_id, &[msg_input]).await?;
        if inserted > 0 {
            debug!("[SharedDB] Synced 1 message to shared database");
        }

        Ok(())
    }
}

fn format_tool_description(tool_name: &str, input: &serde_json::Value) -> String {
    match tool_name {
        "Bash" => format!(
            "Execute: {}",
            input.get("command").and_then(|v| v.as_str()).unwrap_or("unknown")
        ),
        "Write" => format!(
            "Write file: {}",
            input.get("file_path").and_then(|v| v.as_str()).unwrap_or("unknown")
        ),
        "Edit" => format!(
            "Edit file: {}",
            input.get("file_path").and_then(|v| v.as_str()).unwrap_or("unknown")
        ),
        "Delete" => format!(
            "Delete file: {}",
            input.get("file_path").and_then(|v| v.as_str()).unwrap_or("unknown")
        ),
        _ => format!("Call tool: {}", tool_name),
    }
}
