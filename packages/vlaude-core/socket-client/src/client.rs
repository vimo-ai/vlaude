//! Socket.IO 客户端实现

use crate::error::SocketError;
use crate::events::*;
use crate::registry::{DaemonInfo, ServiceEventType, ServiceRegistry, ServiceRegistryConfig, SessionInfo};
use anyhow::Result;
use native_tls::{Certificate, Identity, TlsConnector};
use rust_socketio::{
    asynchronous::{Client, ClientBuilder},
    Payload,
};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, RwLock};
use tracing::{debug, error, info, warn};

/// TLS 配置
#[derive(Debug, Clone, Default)]
pub struct TlsConfig {
    /// CA 证书路径
    pub ca_cert_path: Option<PathBuf>,
    /// 客户端证书路径 (PEM 或 P12)
    pub client_cert_path: Option<PathBuf>,
    /// 客户端私钥路径 (PEM)，P12 时不需要
    pub client_key_path: Option<PathBuf>,
    /// P12 密码（如果使用 PKCS#12 格式）
    pub client_p12_password: Option<String>,
    /// 是否跳过服务器证书验证（仅开发用）
    pub danger_accept_invalid_certs: bool,
}

/// Socket 客户端配置
#[derive(Debug, Clone)]
pub struct SocketConfig {
    /// 服务器 URL（如果启用 Redis 发现，此值可被覆盖）
    pub url: String,
    /// 命名空间
    pub namespace: String,
    /// TLS 配置
    pub tls: TlsConfig,
    /// Redis 配置（可选，启用后支持服务发现和状态注册）
    pub redis: Option<ServiceRegistryConfig>,
    /// Daemon 信息（启用 Redis 时必填，用于注册到 Redis）
    pub daemon_info: Option<DaemonRegistration>,
}

/// Daemon 注册信息
#[derive(Debug, Clone)]
pub struct DaemonRegistration {
    /// 设备 ID（唯一标识）
    pub device_id: String,
    /// 设备名称（显示用）
    pub device_name: String,
    /// 平台（darwin/linux/windows）
    pub platform: String,
    /// 版本
    pub version: String,
    /// TTL（秒）
    pub ttl: u64,
}

impl Default for SocketConfig {
    fn default() -> Self {
        // 从环境变量读取配置，默认 localhost:10005
        let host = std::env::var("VLAUDE_SERVER_HOST").unwrap_or_else(|_| "localhost".to_string());
        let port = std::env::var("VLAUDE_SERVER_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(10005);
        let protocol = if std::env::var("VLAUDE_USE_TLS").map(|v| v == "true").unwrap_or(true) {
            "https"
        } else {
            "http"
        };

        Self {
            url: format!("{}://{}:{}", protocol, host, port),
            namespace: "/daemon".to_string(),
            tls: TlsConfig::default(),
            redis: None,
            daemon_info: None,
        }
    }
}

/// Socket 客户端
pub struct SocketClient {
    config: SocketConfig,
    client: Arc<RwLock<Option<Client>>>,
    connected: Arc<AtomicBool>,
    event_tx: mpsc::Sender<(String, Value)>,
    event_rx: Arc<RwLock<mpsc::Receiver<(String, Value)>>>,
    /// Redis 服务注册中心（可选）
    registry: Arc<RwLock<Option<ServiceRegistry>>>,
    /// 当前使用的 Server URL（可能通过 Redis 发现）
    current_url: Arc<RwLock<String>>,
    /// 心跳任务句柄
    keepalive_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
    /// 事件监听任务句柄（监听 Server online 事件触发重连）
    event_listener_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
    /// 重连通知 channel
    reconnect_tx: mpsc::Sender<()>,
    reconnect_rx: Arc<RwLock<mpsc::Receiver<()>>>,
}

impl SocketClient {
    /// 创建客户端
    pub fn new(config: SocketConfig) -> Self {
        let (event_tx, event_rx) = mpsc::channel(100);
        let (reconnect_tx, reconnect_rx) = mpsc::channel(1);
        let current_url = config.url.clone();

        Self {
            config,
            client: Arc::new(RwLock::new(None)),
            connected: Arc::new(AtomicBool::new(false)),
            event_tx,
            event_rx: Arc::new(RwLock::new(event_rx)),
            registry: Arc::new(RwLock::new(None)),
            current_url: Arc::new(RwLock::new(current_url)),
            keepalive_handle: Arc::new(RwLock::new(None)),
            event_listener_handle: Arc::new(RwLock::new(None)),
            reconnect_tx,
            reconnect_rx: Arc::new(RwLock::new(reconnect_rx)),
        }
    }

    /// 使用默认配置创建
    pub fn with_url(url: &str) -> Self {
        let mut config = SocketConfig::default();
        config.url = url.to_string();
        Self::new(config)
    }

    // ==================== Redis 服务发现 ====================

    /// 初始化 Redis 连接（如果配置了 Redis）
    pub async fn init_registry(&self) -> Result<(), SocketError> {
        if let Some(redis_config) = &self.config.redis {
            let registry = ServiceRegistry::new(redis_config.clone())
                .map_err(|e| SocketError::RegistryError(e.to_string()))?;

            registry
                .connect()
                .await
                .map_err(|e| SocketError::RegistryError(e.to_string()))?;

            // 启动事件监听
            registry
                .start_listening()
                .await
                .map_err(|e| SocketError::RegistryError(e.to_string()))?;

            *self.registry.write().await = Some(registry);
            info!("[SocketClient] Redis registry initialized");
        }
        Ok(())
    }

    /// 通过 Redis 发现 Server 地址
    pub async fn discover_server(&self) -> Result<Option<String>, SocketError> {
        let registry = self.registry.read().await;
        if let Some(ref reg) = *registry {
            let servers = reg
                .get_servers()
                .await
                .map_err(|e| SocketError::RegistryError(e.to_string()))?;

            if let Some(addr) = servers.first() {
                info!("[SocketClient] Discovered server: {}", addr);
                return Ok(Some(addr.clone()));
            }
        }
        Ok(None)
    }

    /// 注册 Daemon 到 Redis
    pub async fn register_daemon_to_redis(&self) -> Result<(), SocketError> {
        let registry = self.registry.read().await;
        let daemon_reg = self.config.daemon_info.as_ref();

        if let (Some(ref reg), Some(info)) = (&*registry, daemon_reg) {
            let daemon_info = DaemonInfo {
                device_id: info.device_id.clone(),
                device_name: info.device_name.clone(),
                platform: info.platform.clone(),
                version: info.version.clone(),
                sessions: vec![],
                registered_at: chrono::Utc::now().timestamp_millis() as u64,
            };

            reg.register_daemon(&daemon_info, info.ttl)
                .await
                .map_err(|e| SocketError::RegistryError(e.to_string()))?;

            info!(
                "[SocketClient] Daemon registered to Redis: {}",
                info.device_id
            );
        }
        Ok(())
    }

    /// 从 Redis 注销 Daemon
    pub async fn unregister_daemon_from_redis(&self) -> Result<(), SocketError> {
        let registry = self.registry.read().await;
        let daemon_reg = self.config.daemon_info.as_ref();

        if let (Some(ref reg), Some(info)) = (&*registry, daemon_reg) {
            reg.unregister_daemon(&info.device_id)
                .await
                .map_err(|e| SocketError::RegistryError(e.to_string()))?;

            info!(
                "[SocketClient] Daemon unregistered from Redis: {}",
                info.device_id
            );
        }
        Ok(())
    }

    /// 更新 Redis 中的 Session 列表
    pub async fn update_sessions_in_redis(
        &self,
        sessions: Vec<SessionInfo>,
    ) -> Result<(), SocketError> {
        let registry = self.registry.read().await;
        let daemon_reg = self.config.daemon_info.as_ref();

        if let (Some(ref reg), Some(info)) = (&*registry, daemon_reg) {
            reg.update_daemon_sessions(&info.device_id, sessions, info.ttl)
                .await
                .map_err(|e| SocketError::RegistryError(e.to_string()))?;
        }
        Ok(())
    }

    /// 启动心跳续期任务
    pub async fn start_keepalive(&self) {
        // 停止旧的心跳任务
        self.stop_keepalive().await;

        let registry = self.registry.clone();
        let daemon_info = self.config.daemon_info.clone();

        if daemon_info.is_none() {
            return;
        }

        let info = daemon_info.unwrap();
        let interval = std::time::Duration::from_secs(info.ttl / 2); // TTL 的一半

        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;

                let reg = registry.read().await;
                if let Some(ref r) = *reg {
                    if let Err(e) = r.keep_alive_daemon(&info.device_id, info.ttl).await {
                        warn!("[SocketClient] Keepalive failed: {}", e);
                        // 如果 key 不存在，需要重新注册
                        // 这里简单地继续尝试，上层应该处理重连逻辑
                    }
                } else {
                    break;
                }
            }
        });

        *self.keepalive_handle.write().await = Some(handle);
        info!("[SocketClient] Keepalive task started");
    }

    /// 停止心跳续期任务
    pub async fn stop_keepalive(&self) {
        if let Some(handle) = self.keepalive_handle.write().await.take() {
            handle.abort();
            info!("[SocketClient] Keepalive task stopped");
        }
    }

    /// 启动事件监听任务（监听 Server online 事件触发重连）
    async fn start_event_listener(&self) {
        // 停止旧的监听任务
        self.stop_event_listener().await;

        let registry = self.registry.clone();
        let reconnect_tx = self.reconnect_tx.clone();
        let connected = self.connected.clone();

        let handle = tokio::spawn(async move {
            // 获取 registry 的事件接收器
            let rx = {
                let reg_guard = registry.read().await;
                if let Some(ref reg) = *reg_guard {
                    Some(reg.subscribe())
                } else {
                    None
                }
            };

            if let Some(mut rx) = rx {
                info!("[SocketClient] Event listener started");
                loop {
                    match rx.recv().await {
                        Ok(event) => {
                            // 只处理 server online 事件
                            if event.service == "server" && event.event_type == ServiceEventType::Online {
                                let is_connected = connected.load(Ordering::SeqCst);
                                if !is_connected {
                                    info!(
                                        "[SocketClient] Server online detected: {:?}, triggering reconnect",
                                        event.address
                                    );
                                    // 发送重连信号
                                    let _ = reconnect_tx.send(()).await;
                                } else {
                                    debug!("[SocketClient] Server online but already connected, ignoring");
                                }
                            }
                        }
                        Err(e) => {
                            warn!("[SocketClient] Event receiver error: {}, resubscribing...", e);
                            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                            // 尝试重新订阅
                            let reg_guard = registry.read().await;
                            if let Some(ref reg) = *reg_guard {
                                rx = reg.subscribe();
                            } else {
                                break;
                            }
                        }
                    }
                }
            }
        });

        *self.event_listener_handle.write().await = Some(handle);
    }

    /// 停止事件监听任务
    async fn stop_event_listener(&self) {
        if let Some(handle) = self.event_listener_handle.write().await.take() {
            handle.abort();
            info!("[SocketClient] Event listener stopped");
        }
    }

    /// 等待重连信号（阻塞直到收到信号）
    pub async fn wait_for_reconnect(&self) -> bool {
        self.reconnect_rx.write().await.recv().await.is_some()
    }

    /// 尝试接收重连信号（非阻塞）
    pub async fn try_recv_reconnect(&self) -> bool {
        self.reconnect_rx.write().await.try_recv().is_ok()
    }

    /// 连接并自动发现（如果启用 Redis）
    pub async fn connect_with_discovery(&self) -> Result<(), SocketError> {
        // 1. 初始化 Redis
        self.init_registry().await?;

        // 2. 启动事件监听（监听 Server online 事件）
        self.start_event_listener().await;

        // 3. 尝试从 Redis 发现 Server
        if let Some(server_addr) = self.discover_server().await? {
            // 使用发现的地址（添加 https:// 协议前缀）
            *self.current_url.write().await = format!("https://{}", server_addr);
        }

        // 4. 连接 Socket
        self.connect().await?;

        // 5. 注册到 Redis
        self.register_daemon_to_redis().await?;

        // 6. 启动心跳
        self.start_keepalive().await;

        Ok(())
    }

    /// 重新连接（Server 重启后调用）
    pub async fn reconnect(&self) -> Result<(), SocketError> {
        info!("[SocketClient] Reconnecting...");

        // 1. 断开旧连接（但不注销 Redis）
        self.stop_keepalive().await;
        if let Some(client) = self.client.write().await.take() {
            let _ = client.disconnect().await;
        }
        self.connected.store(false, Ordering::SeqCst);

        // 2. 重新发现 Server
        if let Some(server_addr) = self.discover_server().await? {
            // 添加 https:// 协议前缀
            *self.current_url.write().await = format!("https://{}", server_addr);
        }

        // 3. 重新连接
        self.connect().await?;

        // 4. 重新注册到 Redis
        self.register_daemon_to_redis().await?;

        // 5. 重启心跳
        self.start_keepalive().await;

        info!("[SocketClient] Reconnected successfully");
        Ok(())
    }

    /// 获取 ServiceRegistry 引用（用于外部访问）
    pub async fn get_registry(&self) -> Option<Arc<RwLock<Option<ServiceRegistry>>>> {
        if self.registry.read().await.is_some() {
            Some(self.registry.clone())
        } else {
            None
        }
    }

    /// 构建 TLS 连接器（支持 mTLS）
    fn build_tls_connector(&self) -> Result<Option<TlsConnector>, SocketError> {
        let tls = &self.config.tls;

        // 如果没有 TLS 配置，返回 None
        if tls.ca_cert_path.is_none()
            && tls.client_cert_path.is_none()
            && !tls.danger_accept_invalid_certs
        {
            return Ok(None);
        }

        let mut builder = native_tls::TlsConnector::builder();

        // 加载 CA 证书
        if let Some(ca_path) = &tls.ca_cert_path {
            info!("Loading CA certificate from {:?}", ca_path);
            let ca_pem = fs::read(ca_path).map_err(|e| {
                SocketError::TlsError(format!("Failed to read CA cert: {}", e))
            })?;
            let ca_cert = Certificate::from_pem(&ca_pem).map_err(|e| {
                SocketError::TlsError(format!("Failed to parse CA cert: {}", e))
            })?;
            builder.add_root_certificate(ca_cert);
        }

        // 加载客户端证书（mTLS）
        if let Some(cert_path) = &tls.client_cert_path {
            info!("Loading client certificate from {:?}", cert_path);
            let cert_data = fs::read(cert_path).map_err(|e| {
                SocketError::TlsError(format!("Failed to read client cert: {}", e))
            })?;

            // 检查是否是 P12 格式
            let is_p12 = cert_path
                .extension()
                .map(|ext| ext == "p12" || ext == "pfx")
                .unwrap_or(false);

            let identity = if is_p12 {
                // PKCS#12 格式
                let password = tls.client_p12_password.as_deref().unwrap_or("");
                Identity::from_pkcs12(&cert_data, password).map_err(|e| {
                    SocketError::TlsError(format!("Failed to parse PKCS#12: {}", e))
                })?
            } else {
                // PEM 格式
                let key_pem = if let Some(key_path) = &tls.client_key_path {
                    fs::read(key_path).map_err(|e| {
                        SocketError::TlsError(format!("Failed to read client key: {}", e))
                    })?
                } else {
                    return Err(SocketError::TlsError(
                        "Client key path required for PEM format".into(),
                    ));
                };
                Identity::from_pkcs8(&cert_data, &key_pem).map_err(|e| {
                    SocketError::TlsError(format!("Failed to create identity from PEM: {}", e))
                })?
            };
            builder.identity(identity);
        }

        // 开发模式：跳过证书验证
        if tls.danger_accept_invalid_certs {
            warn!("TLS certificate verification disabled - FOR DEVELOPMENT ONLY");
            builder.danger_accept_invalid_certs(true);
        }

        let connector = builder.build().map_err(|e| {
            SocketError::TlsError(format!("Failed to build TLS connector: {}", e))
        })?;

        Ok(Some(connector))
    }

    /// 连接到服务器
    pub async fn connect(&self) -> Result<(), SocketError> {
        // 使用 current_url（可能是通过 Redis 发现的）
        let base_url = self.current_url.read().await.clone();
        let url = format!("{}{}", base_url, self.config.namespace);
        info!("Connecting to {}", url);

        let connected = self.connected.clone();
        let event_tx = self.event_tx.clone();

        // 构建 TLS 连接器
        let tls_connector = self.build_tls_connector()?;

        // 构建客户端（强制使用 WebSocket 避免 Fastify polling 兼容性问题）
        let mut builder = ClientBuilder::new(&base_url)
            .namespace(&self.config.namespace)
            .transport_type(rust_socketio::TransportType::Websocket);

        // 如果有 TLS 配置则应用
        if let Some(connector) = tls_connector {
            builder = builder.tls_config(connector);
        }

        let client = builder
            .on("connect", move |_, _| {
                let connected = connected.clone();
                async move {
                    info!("Socket connected");
                    connected.store(true, Ordering::SeqCst);
                }
                .boxed()
            })
            .on("disconnect", {
                let connected = self.connected.clone();
                let tx = event_tx.clone();
                move |_, _| {
                    let connected = connected.clone();
                    let tx = tx.clone();
                    async move {
                        warn!("Socket disconnected");
                        connected.store(false, Ordering::SeqCst);
                        // 发送断开事件，让上层处理重连
                        let _ = tx.send(("__disconnected".into(), json!({}))).await;
                    }
                    .boxed()
                }
            })
            .on("error", {
                let connected = self.connected.clone();
                let tx = event_tx.clone();
                move |err, _| {
                    let connected = connected.clone();
                    let tx = tx.clone();
                    async move {
                        error!("Socket error: {:?}", err);
                        // 设置断开状态，触发重连
                        connected.store(false, Ordering::SeqCst);
                        let _ = tx.send(("__disconnected".into(), json!({}))).await;
                    }
                    .boxed()
                }
            })
            // Server events
            .on("server:requestProjectData", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:requestProjectData".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:requestSessionMetadata", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:requestSessionMetadata".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:requestSessionMessages", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:requestSessionMessages".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:startWatching", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:startWatching".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:stopWatching", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:stopWatching".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:mobileViewing", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:mobileViewing".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            // 缺失的服务器事件
            .on("server:resumeLocal", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:resumeLocal".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:watchNewSession", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:watchNewSession".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:findNewSession", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:findNewSession".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:sessionDiscovered", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:sessionDiscovered".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:approvalResponse", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:approvalResponse".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:command", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:command".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            // V3: 写操作事件（从 HTTP API 改为 WebSocket）
            .on("server:createSession", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:createSession".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:checkLoading", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:checkLoading".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server:sendMessage", {
                let tx = event_tx.clone();
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        if let Some(data) = extract_payload(payload) {
                            let _ = tx.send(("server:sendMessage".into(), data)).await;
                        }
                    }
                    .boxed()
                }
            })
            .on("server-shutdown", {
                let tx = event_tx.clone();
                move |_, _| {
                    let tx = tx.clone();
                    async move {
                        let _ = tx.send(("server-shutdown".into(), json!({}))).await;
                    }
                    .boxed()
                }
            })
            .connect()
            .await
            .map_err(|e| SocketError::ConnectionFailed(e.to_string()))?;

        // connect() 成功后设置连接状态（不依赖 connect 回调，rust_socketio 的回调行为不可靠）
        self.connected.store(true, Ordering::SeqCst);
        info!("Socket connected successfully");

        *self.client.write().await = Some(client);
        Ok(())
    }

    /// 断开连接
    pub async fn disconnect(&self) {
        // 1. 停止心跳任务
        self.stop_keepalive().await;

        // 2. 停止事件监听任务
        self.stop_event_listener().await;

        // 3. 从 Redis 注销（忽略错误，因为可能 Redis 已断开）
        let _ = self.unregister_daemon_from_redis().await;

        // 4. 断开 Socket
        if let Some(client) = self.client.write().await.take() {
            if let Err(e) = client.disconnect().await {
                error!("Disconnect error: {:?}", e);
            }
        }
        self.connected.store(false, Ordering::SeqCst);

        // 5. 断开 Redis
        if let Some(ref registry) = *self.registry.read().await {
            registry.disconnect().await;
        }
        *self.registry.write().await = None;
    }

    /// 是否已连接
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// 发送事件
    pub async fn emit(&self, event: &str, data: Value) -> Result<(), SocketError> {
        debug!("Emitting event: {}", event);
        let client = self.client.read().await;
        let client = client.as_ref().ok_or(SocketError::NotConnected)?;

        client
            .emit(event, data)
            .await
            .map_err(|e| SocketError::EmitFailed(e.to_string()))?;

        debug!("Event emitted: {}", event);
        Ok(())
    }

    /// 发送事件并等待 Ack
    pub async fn emit_with_ack(
        &self,
        event: &str,
        data: Value,
        timeout_secs: u64,
    ) -> Result<Value, SocketError> {
        let client = self.client.read().await;
        let client = client.as_ref().ok_or(SocketError::NotConnected)?;

        // 使用 oneshot channel 捕获 ack payload
        let (tx, rx) = oneshot::channel::<Value>();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));

        client
            .emit_with_ack(
                event,
                data,
                std::time::Duration::from_secs(timeout_secs),
                move |payload, _| {
                    let tx = tx.clone();
                    async move {
                        debug!("Ack received: {:?}", payload);
                        let value = match payload {
                            Payload::Text(values) => {
                                values.into_iter().next().unwrap_or(json!({"success": true}))
                            }
                            _ => json!({"success": true}),
                        };
                        if let Some(sender) = tx.lock().unwrap().take() {
                            let _ = sender.send(value);
                        }
                    }
                    .boxed()
                },
            )
            .await
            .map_err(|e| SocketError::EmitFailed(e.to_string()))?;

        // 等待 ack 返回
        match rx.await {
            Ok(value) => Ok(value),
            Err(_) => Ok(json!({"success": true})), // channel 关闭，返回默认值
        }
    }

    /// 接收下一个事件
    pub async fn recv_event(&self) -> Option<(String, Value)> {
        self.event_rx.write().await.recv().await
    }

    /// 接收事件（带超时）
    pub async fn recv_event_timeout(&self, timeout: std::time::Duration) -> Option<(String, Value)> {
        let mut rx = self.event_rx.write().await;
        match tokio::time::timeout(timeout, rx.recv()).await {
            Ok(result) => result,
            Err(_) => None, // 超时
        }
    }

    /// 尝试接收事件（非阻塞）
    pub fn try_recv_event(&self) -> Option<(String, Value)> {
        // 注意：这里需要在异步上下文中使用
        // 非阻塞版本需要不同实现
        None
    }

    // ==================== 便捷方法 ====================

    /// 注册 daemon
    pub async fn register(&self, data: RegisterData) -> Result<Value, SocketError> {
        // 暂时用普通 emit，避免 ack 阻塞问题
        self.emit("daemon:register", serde_json::to_value(data).unwrap())
            .await?;
        Ok(json!({"success": true}))
    }

    /// 上报在线（ETerm 专用事件名）
    pub async fn report_online(&self) -> Result<(), SocketError> {
        let data = OnlineData {
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        self.emit("daemon:etermOnline", serde_json::to_value(data).unwrap())
            .await
    }

    /// 上报离线（ETerm 专用事件名）
    pub async fn report_offline(&self) -> Result<(), SocketError> {
        let data = OfflineData {
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        self.emit("daemon:etermOffline", serde_json::to_value(data).unwrap())
            .await
    }

    /// 上报项目数据
    pub async fn report_project_data(
        &self,
        projects: Vec<Value>,
        request_id: Option<String>,
    ) -> Result<(), SocketError> {
        let data = ProjectDataPayload {
            projects,
            request_id,
        };
        self.emit("daemon:projectData", serde_json::to_value(data).unwrap())
            .await
    }

    /// 上报会话元数据
    pub async fn report_session_metadata(
        &self,
        sessions: Vec<Value>,
        project_path: Option<String>,
        request_id: Option<String>,
    ) -> Result<(), SocketError> {
        let data = SessionMetadataPayload {
            sessions,
            project_path,
            request_id,
        };
        self.emit(
            "daemon:sessionMetadata",
            serde_json::to_value(data).unwrap(),
        )
        .await
    }

    /// 上报新消息
    pub async fn notify_new_message(
        &self,
        session_id: &str,
        message: Value,
    ) -> Result<(), SocketError> {
        let data = NewMessageData {
            session_id: session_id.to_string(),
            message,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        self.emit("daemon:newMessage", serde_json::to_value(data).unwrap())
            .await
    }

    /// 上报 Metrics 更新
    pub async fn notify_metrics_update(
        &self,
        session_id: &str,
        metrics: Value,
    ) -> Result<(), SocketError> {
        let data = MetricsUpdateData {
            session_id: session_id.to_string(),
            metrics,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        self.emit("daemon:metricsUpdate", serde_json::to_value(data).unwrap())
            .await
    }

    /// 上报会话消息
    pub async fn report_session_messages(
        &self,
        session_id: String,
        project_path: String,
        messages: Vec<Value>,
        total: usize,
        has_more: bool,
        request_id: Option<String>,
    ) -> Result<(), SocketError> {
        let data = SessionMessagesPayload {
            session_id,
            project_path,
            messages,
            total,
            has_more,
            request_id,
        };
        self.emit("daemon:sessionMessages", serde_json::to_value(data).unwrap())
            .await
    }

    // ==================== 其他上行事件方法 ====================

    /// 通知找到新会话
    pub async fn notify_new_session_found(
        &self,
        client_id: &str,
        session_id: &str,
        project_path: &str,
        encoded_dir_name: &str,
    ) -> Result<(), SocketError> {
        let data = NewSessionFoundData {
            client_id: client_id.to_string(),
            session_id: session_id.to_string(),
            project_path: project_path.to_string(),
            encoded_dir_name: encoded_dir_name.to_string(),
        };
        self.emit("daemon:newSessionFound", serde_json::to_value(data).unwrap())
            .await
    }

    /// 通知未找到新会话
    pub async fn notify_new_session_not_found(
        &self,
        client_id: &str,
        project_path: &str,
    ) -> Result<(), SocketError> {
        let data = NewSessionNotFoundData {
            client_id: client_id.to_string(),
            project_path: project_path.to_string(),
        };
        self.emit("daemon:newSessionNotFound", serde_json::to_value(data).unwrap())
            .await
    }

    /// 通知监听器已启动
    pub async fn notify_watch_started(
        &self,
        client_id: &str,
        project_path: &str,
    ) -> Result<(), SocketError> {
        let data = WatchStartedData {
            client_id: client_id.to_string(),
            project_path: project_path.to_string(),
        };
        self.emit("daemon:watchStarted", serde_json::to_value(data).unwrap())
            .await
    }

    /// 通知新会话已创建
    pub async fn notify_new_session_created(
        &self,
        client_id: &str,
        session_id: &str,
        project_path: &str,
    ) -> Result<(), SocketError> {
        let data = NewSessionCreatedData {
            client_id: client_id.to_string(),
            session_id: session_id.to_string(),
            project_path: project_path.to_string(),
        };
        self.emit("daemon:newSessionCreated", serde_json::to_value(data).unwrap())
            .await
    }

    /// 通知项目更新
    pub async fn notify_project_update(
        &self,
        project_path: &str,
        metadata: Option<Value>,
    ) -> Result<(), SocketError> {
        let data = ProjectUpdateData {
            project_path: project_path.to_string(),
            metadata,
        };
        self.emit("daemon:projectUpdate", serde_json::to_value(data).unwrap())
            .await
    }

    /// 通知会话更新
    pub async fn notify_session_update(
        &self,
        session_id: &str,
        metadata: Value,
    ) -> Result<(), SocketError> {
        let data = SessionUpdateData {
            session_id: session_id.to_string(),
            metadata,
        };
        self.emit("daemon:sessionUpdate", serde_json::to_value(data).unwrap())
            .await
    }

    /// 通知项目列表更新
    pub async fn notify_project_list_update(&self) -> Result<(), SocketError> {
        self.emit("daemon:projectListUpdate", json!({})).await
    }

    /// 通知会话列表更新
    pub async fn notify_session_list_update(&self, project_path: &str) -> Result<(), SocketError> {
        self.emit("daemon:sessionListUpdate", json!({ "projectPath": project_path }))
            .await
    }

    /// 通知会话详情更新
    pub async fn notify_session_detail_update(
        &self,
        session_id: &str,
        project_path: &str,
    ) -> Result<(), SocketError> {
        let data = SessionDetailUpdateData {
            session_id: session_id.to_string(),
            project_path: project_path.to_string(),
        };
        self.emit("daemon:sessionDetailUpdate", serde_json::to_value(data).unwrap())
            .await
    }

    /// 通知会话已恢复
    pub async fn notify_session_restored(
        &self,
        session_id: &str,
        project_path: &str,
    ) -> Result<(), SocketError> {
        let data = SessionRestoredData {
            session_id: session_id.to_string(),
            project_path: project_path.to_string(),
        };
        self.emit("daemon:sessionRestored", serde_json::to_value(data).unwrap())
            .await
    }

    /// 通知会话已删除
    pub async fn notify_session_deleted(
        &self,
        session_id: &str,
        project_path: &str,
    ) -> Result<(), SocketError> {
        let data = SessionDeletedData {
            session_id: session_id.to_string(),
            project_path: project_path.to_string(),
        };
        self.emit("daemon:sessionDeleted", serde_json::to_value(data).unwrap())
            .await
    }

    /// 发送权限请求
    pub async fn send_approval_request(
        &self,
        request_id: &str,
        session_id: &str,
        client_id: &str,
        tool_name: &str,
        input: Value,
        tool_use_id: &str,
        description: &str,
    ) -> Result<(), SocketError> {
        let data = ApprovalRequestData {
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
            client_id: client_id.to_string(),
            tool_name: tool_name.to_string(),
            input,
            tool_use_id: tool_use_id.to_string(),
            description: description.to_string(),
        };
        self.emit("daemon:approvalRequest", serde_json::to_value(data).unwrap())
            .await
    }

    /// 发送权限超时通知
    pub async fn send_approval_timeout(
        &self,
        request_id: &str,
        session_id: &str,
        client_id: &str,
    ) -> Result<(), SocketError> {
        let data = ApprovalTimeoutData {
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
            client_id: client_id.to_string(),
        };
        self.emit("daemon:approvalTimeout", serde_json::to_value(data).unwrap())
            .await
    }

    /// 发送权限过期通知
    pub async fn send_approval_expired(
        &self,
        request_id: &str,
        message: &str,
    ) -> Result<(), SocketError> {
        let data = ApprovalExpiredData {
            request_id: request_id.to_string(),
            message: message.to_string(),
        };
        self.emit("daemon:approvalExpired", serde_json::to_value(data).unwrap())
            .await
    }

    /// 发送 SDK 错误通知
    pub async fn send_sdk_error(
        &self,
        session_id: &str,
        client_id: &str,
        error_type: &str,
        message: &str,
    ) -> Result<(), SocketError> {
        let data = SdkErrorData {
            session_id: session_id.to_string(),
            client_id: client_id.to_string(),
            error: SdkErrorInfo {
                error_type: error_type.to_string(),
                message: message.to_string(),
            },
        };
        self.emit("daemon:sdkError", serde_json::to_value(data).unwrap())
            .await
    }

    /// 发送 Swift 活动通知
    pub async fn send_swift_activity(
        &self,
        session_id: &str,
        project_path: &str,
    ) -> Result<(), SocketError> {
        let data = SwiftActivityData {
            session_id: session_id.to_string(),
            project_path: project_path.to_string(),
        };
        self.emit("daemon:swiftActivity", serde_json::to_value(data).unwrap())
            .await
    }

    // ==================== V3: 写操作响应方法 ====================

    /// 发送会话创建结果
    pub async fn send_session_created_result(
        &self,
        request_id: &str,
        success: bool,
        session_id: Option<&str>,
        encoded_dir_name: Option<&str>,
        transcript_path: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), SocketError> {
        let data = json!({
            "requestId": request_id,
            "success": success,
            "sessionId": session_id,
            "encodedDirName": encoded_dir_name,
            "transcriptPath": transcript_path,
            "error": error,
        });
        self.emit("daemon:sessionCreatedResult", data).await
    }

    /// 发送加载状态检查结果
    pub async fn send_check_loading_result(
        &self,
        request_id: &str,
        loading: bool,
    ) -> Result<(), SocketError> {
        let data = json!({
            "requestId": request_id,
            "loading": loading,
        });
        self.emit("daemon:checkLoadingResult", data).await
    }

    /// 发送消息发送结果
    pub async fn send_message_result(
        &self,
        request_id: &str,
        success: bool,
        message: Option<&str>,
        via: Option<&str>,
    ) -> Result<(), SocketError> {
        let data = json!({
            "requestId": request_id,
            "success": success,
            "message": message,
            "via": via,
        });
        self.emit("daemon:sendMessageResult", data).await
    }
}

// Helper 函数
fn extract_payload(payload: Payload) -> Option<Value> {
    match payload {
        Payload::Text(values) => values.into_iter().next(),
        Payload::Binary(_) => None,
        _ => None,
    }
}

// 需要 FutureExt trait
use futures::FutureExt;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_socket_config_default() {
        let config = SocketConfig::default();
        assert_eq!(config.url, "https://localhost:10005");
        assert_eq!(config.namespace, "/daemon");
    }
}
