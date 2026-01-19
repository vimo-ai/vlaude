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
use std::time::Instant;
use tokio::sync::{oneshot, RwLock};
use tokio::time::Duration;
use tracing::{debug, error, info, warn};
use socket_client::vlaude_log_info;

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

// ==================== ETerm 操作回调类型 ====================

/// 创建会话回调结果
#[derive(Debug, Clone, Default)]
pub struct CreateSessionResult {
    pub success: bool,
    pub session_id: Option<String>,
    pub project_path: Option<String>,
    pub encoded_dir_name: Option<String>,
    pub error: Option<String>,
}

/// 发送消息回调结果
#[derive(Debug, Clone, Default)]
pub struct SendMessageResult {
    pub success: bool,
    pub error: Option<String>,
    pub message_id: Option<String>,
}

/// 创建会话回调类型
/// 参数: (project_path, prompt, request_id)
/// 返回: CreateSessionResult
pub type CreateSessionCallback = Arc<dyn Fn(&str, Option<&str>, &str) -> CreateSessionResult + Send + Sync>;

/// 发送消息回调类型
/// 参数: (session_id, text, request_id)
/// 返回: SendMessageResult
pub type SendMessageCallback = Arc<dyn Fn(&str, &str, &str) -> SendMessageResult + Send + Sync>;

/// 检查加载状态回调类型
/// 参数: (session_id, request_id)
/// 返回: is_loading (bool)
pub type CheckLoadingCallback = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

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
#[allow(dead_code)]
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
    /// 创建会话回调 (ETerm)
    create_session_callback: Arc<RwLock<Option<CreateSessionCallback>>>,
    /// 发送消息回调 (ETerm)
    send_message_callback: Arc<RwLock<Option<SendMessageCallback>>>,
    /// 检查加载状态回调 (ETerm)
    check_loading_callback: Arc<RwLock<Option<CheckLoadingCallback>>>,
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
            reader: Arc::new(RwLock::new(ClaudeReader::with_default_path()?)),
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
            create_session_callback: Arc::new(RwLock::new(None)),
            send_message_callback: Arc::new(RwLock::new(None)),
            check_loading_callback: Arc::new(RwLock::new(None)),
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
            reader: Arc::new(RwLock::new(ClaudeReader::with_default_path()?)),
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
            create_session_callback: Arc::new(RwLock::new(None)),
            send_message_callback: Arc::new(RwLock::new(None)),
            check_loading_callback: Arc::new(RwLock::new(None)),
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

    /// 设置创建会话回调 (ETerm)
    pub async fn set_create_session_callback(&self, callback: CreateSessionCallback) {
        *self.create_session_callback.write().await = Some(callback);
    }

    /// 设置发送消息回调 (ETerm)
    pub async fn set_send_message_callback(&self, callback: SendMessageCallback) {
        *self.send_message_callback.write().await = Some(callback);
    }

    /// 设置检查加载状态回调 (ETerm)
    pub async fn set_check_loading_callback(&self, callback: CheckLoadingCallback) {
        *self.check_loading_callback.write().await = Some(callback);
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

        // 从 DB 读取（禁止降级）
        let db = self.shared_db.as_ref()
            .ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;

        // 1. 推送项目列表（从 DB）
        let projects = db.list_projects_with_stats(20, 0).await?;
        let projects_json: Vec<serde_json::Value> = projects
            .into_iter()
            .map(|p| serde_json::to_value(p).unwrap())
            .collect();

        info!("Pushing {} projects to server", projects_json.len());
        self.socket.read().await.report_project_data(projects_json.clone(), None).await?;

        // 2. 推送每个项目的会话列表（从 DB，每个项目最多 50 个）
        for project_json in &projects_json {
            if let Some(project_path) = project_json.get("projectPath").and_then(|v| v.as_str()) {
                let sessions = db.list_sessions_by_project_path(project_path, 50, 0).await?;
                if !sessions.is_empty() {
                    let sessions_json: Vec<serde_json::Value> = sessions
                        .into_iter()
                        .map(|s| serde_json::to_value(s).unwrap())
                        .collect();

                    info!(
                        "Pushing {} sessions for project {} to server",
                        sessions_json.len(),
                        project_path
                    );
                    self.socket.read().await
                        .report_session_metadata(sessions_json, Some(project_path.to_string()), None)
                        .await?;
                }
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
        let total_start = Instant::now();

        let limit = data.get("limit").and_then(|v| v.as_u64()).unwrap_or(1000) as usize;
        let offset = data.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let request_id = data
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // 从 DB 读取（禁止降级）
        let db = self.shared_db.as_ref()
            .ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;

        let db_start = Instant::now();
        let projects = db.list_projects_with_stats(limit, offset).await?;
        let db_elapsed = db_start.elapsed();

        let project_count = projects.len();

        let serialize_start = Instant::now();
        let projects_json: Vec<serde_json::Value> = projects
            .into_iter()
            .map(|p| serde_json::to_value(p).unwrap())
            .collect();
        let serialize_elapsed = serialize_start.elapsed();

        let socket_start = Instant::now();
        self.socket.read().await
            .report_project_data(projects_json, request_id)
            .await?;
        let socket_elapsed = socket_start.elapsed();

        let total_elapsed = total_start.elapsed();
        vlaude_log_info!(
            "[Perf] request_project_data: total={:?}, db={:?}, serialize={:?}, socket={:?}, count={}",
            total_elapsed, db_elapsed, serialize_elapsed, socket_elapsed, project_count
        );

        Ok(())
    }

    async fn handle_request_session_metadata(&self, data: serde_json::Value) -> Result<()> {
        let total_start = Instant::now();

        let project_path = data.get("projectPath").and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("projectPath is required"))?;
        let limit = data.get("limit").and_then(|v| v.as_u64()).unwrap_or(1000) as usize;
        let offset = data.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let request_id = data
            .get("requestId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // 从 DB 读取（禁止降级）
        let db = self.shared_db.as_ref()
            .ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;

        let db_start = Instant::now();
        // agent-* 过滤已在 DB 层 SQL 统一处理
        let sessions = db.list_sessions_by_project_path(project_path, limit, offset).await?;
        let db_elapsed = db_start.elapsed();
        let session_count = sessions.len();

        let serialize_start = Instant::now();
        let sessions_json: Vec<serde_json::Value> = sessions
            .into_iter()
            .map(|s| serde_json::to_value(s).unwrap())
            .collect();
        let serialize_elapsed = serialize_start.elapsed();

        let socket_start = Instant::now();
        self.socket.read().await
            .report_session_metadata(
                sessions_json,
                Some(project_path.to_string()),
                request_id,
            )
            .await?;
        let socket_elapsed = socket_start.elapsed();

        let total_elapsed = total_start.elapsed();
        vlaude_log_info!(
            "[Perf] request_session_metadata: total={:?}, db={:?}, serialize={:?}, socket={:?}, count={}, project={}",
            total_elapsed, db_elapsed, serialize_elapsed, socket_elapsed, session_count, project_path
        );

        Ok(())
    }

    async fn handle_request_session_messages(&self, data: serde_json::Value) -> Result<()> {
        let total_start = Instant::now();

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

        let desc = order_str == "desc";

        // 从 DB 读取（禁止降级）
        let db = self.shared_db.as_ref()
            .ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;

        // 1. 从 DB 读取消息
        let db_start = Instant::now();
        let db_messages = db.get_messages_ordered(session_id, limit, offset, desc).await?;
        let total = db.get_message_count(session_id).await? as usize;
        let db_elapsed = db_start.elapsed();

        let has_more = offset + db_messages.len() < total;

        // 2. 把 DB Message 的 raw 字段解析成 serde_json::Value
        let parse_start = Instant::now();
        let mut messages: Vec<serde_json::Value> = db_messages
            .into_iter()
            .filter_map(|msg| {
                msg.raw.as_ref().and_then(|raw| serde_json::from_str(raw).ok())
            })
            .collect();

        // 解析 contentBlocks 并添加到消息中
        crate::content_blocks::enrich_messages_with_content_blocks(&mut messages);
        let parse_elapsed = parse_start.elapsed();

        let message_count = messages.len();

        // 3. 发送响应
        let socket_start = Instant::now();
        self.socket.read().await
            .report_session_messages(
                session_id.to_string(),
                project_path.to_string(),
                messages,
                total,
                has_more,
                request_id.clone(),
            )
            .await?;
        let socket_elapsed = socket_start.elapsed();

        let total_elapsed = total_start.elapsed();
        vlaude_log_info!(
            "[Perf] request_session_messages: total={:?}, db={:?}, parse={:?}, socket={:?}, count={}, session={}",
            total_elapsed, db_elapsed, parse_elapsed, socket_elapsed, message_count, session_id
        );

        // 4. 异步触发 JSONL 采集（问题 11：保鲜机制）
        self.trigger_session_sync(session_id, project_path).await;

        Ok(())
    }

    /// 异步触发 JSONL 采集（保鲜机制）
    /// 采集完成后，如果有新数据会通过 socket 增量推送
    async fn trigger_session_sync(&self, session_id: &str, project_path: &str) {
        let session_id = session_id.to_string();
        let project_path = project_path.to_string();
        let reader = self.reader.clone();
        let shared_db = self.shared_db.clone();
        let socket = self.socket.clone();

        tokio::spawn(async move {
            if let Err(e) = Self::do_session_sync(&session_id, &project_path, reader, shared_db, socket).await {
                warn!("[SessionSync] Failed to sync session {}: {}", session_id, e);
            }
        });
    }

    /// 执行 JSONL → DB 同步，发现增量则推送
    async fn do_session_sync(
        session_id: &str,
        _project_path: &str,
        reader: Arc<RwLock<ClaudeReader>>,
        shared_db: Option<Arc<SharedDbAdapter>>,
        socket: Arc<RwLock<SocketClient>>,
    ) -> Result<()> {
        let db = shared_db.ok_or_else(|| anyhow::anyhow!("SharedDB not initialized"))?;

        // 获取 DB 中该 session 当前的消息数
        let db_count_before = db.get_message_count(session_id).await? as usize;

        // 从 JSONL 读取新增消息（从 DB 已有数量的位置开始）
        let mut reader_guard = reader.write().await;
        let session_path = match reader_guard.get_session_path(session_id) {
            Some(p) => p,
            None => return Ok(()), // session 不存在，跳过
        };

        // 先读取一条来获取 total 数量
        let jsonl_result = reader_guard.read_messages_raw(&session_path, 1, 0, session_reader::Order::Asc)?;
        let jsonl_count = jsonl_result.total;

        // 如果 JSONL 有更多消息，说明有增量
        if jsonl_count > db_count_before {
            debug!(
                "[SessionSync] Found {} new messages for session {} (DB: {}, JSONL: {})",
                jsonl_count - db_count_before, session_id, db_count_before, jsonl_count
            );

            // 从 DB 已有数量的位置开始读取新增消息
            let new_count = jsonl_count - db_count_before;
            let new_result = reader_guard.read_messages_raw(
                &session_path,
                new_count,           // 只读取新增的数量
                db_count_before,     // 从 DB 已有数量的位置开始
                session_reader::Order::Asc
            )?;
            drop(reader_guard);

            let new_messages: Vec<serde_json::Value> = new_result.messages;

            // 推送新消息给客户端
            for msg in new_messages {
                if let Err(e) = socket.read().await.notify_new_message(session_id, msg).await {
                    warn!("[SessionSync] Failed to push new message: {}", e);
                }
            }

            // 注意：消息写入 DB 是通过 watcher 的 handle_watch_event 完成的
            // 这里只负责推送，不重复写入
        } else {
            drop(reader_guard);
        }

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

        let mut reader = self.reader.write().await;
        let session_path = reader
            .get_session_path(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?;
        let session_path = PathBuf::from(session_path);

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
    /// 通过 ETerm 回调创建会话
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

        // 尝试通过 ETerm 回调创建会话
        let result = if let Some(callback) = self.create_session_callback.read().await.as_ref() {
            callback(project_path, prompt, request_id)
        } else {
            // 没有注册回调，返回失败
            CreateSessionResult {
                success: false,
                error: Some("No ETerm callback registered. Please use ETerm to create sessions.".to_string()),
                ..Default::default()
            }
        };

        self.socket
            .read()
            .await
            .send_session_created_result(
                request_id,
                result.success,
                result.session_id.as_deref(),
                result.project_path.as_deref(),
                result.encoded_dir_name.as_deref(),
                result.error.as_deref(),
            )
            .await?;

        Ok(())
    }

    /// 处理检查加载状态请求
    /// 通过 ETerm 回调检查加载状态
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

        // 尝试通过 ETerm 回调检查加载状态
        let is_loading = if let Some(callback) = self.check_loading_callback.read().await.as_ref() {
            callback(session_id, request_id)
        } else {
            // 没有注册回调，默认返回 false
            false
        };

        self.socket
            .read()
            .await
            .send_check_loading_result(request_id, is_loading)
            .await?;

        Ok(())
    }

    /// 处理发送消息请求
    /// 通过 ETerm 回调发送消息
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

        // 尝试通过 ETerm 回调发送消息
        let result = if let Some(callback) = self.send_message_callback.read().await.as_ref() {
            callback(session_id, text, request_id)
        } else {
            // 没有注册回调，返回失败
            SendMessageResult {
                success: false,
                error: Some("No ETerm callback registered. Please use ETerm to send messages.".to_string()),
                ..Default::default()
            }
        };

        self.socket
            .read()
            .await
            .send_message_result(
                request_id,
                result.success,
                result.error.as_deref(),
                result.message_id.as_deref(),
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
            .rfind(|s| !s.is_empty())
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
            content_text: content.clone(),
            content_full: content,
            timestamp,
            sequence: 0,
            source: Some("claude".to_string()),
            channel: Some("code".to_string()),
            model: None,
            tool_call_id: None,
            tool_name: None,
            tool_args: None,
            raw,
            approval_status: None,
            approval_resolved_at: None,
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
