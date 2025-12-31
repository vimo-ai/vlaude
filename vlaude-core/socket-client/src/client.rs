//! Socket.IO 客户端实现

use crate::error::SocketError;
use crate::events::*;
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
    /// 服务器 URL
    pub url: String,
    /// 命名空间
    pub namespace: String,
    /// TLS 配置
    pub tls: TlsConfig,
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
}

impl SocketClient {
    /// 创建客户端
    pub fn new(config: SocketConfig) -> Self {
        let (event_tx, event_rx) = mpsc::channel(100);

        Self {
            config,
            client: Arc::new(RwLock::new(None)),
            connected: Arc::new(AtomicBool::new(false)),
            event_tx,
            event_rx: Arc::new(RwLock::new(event_rx)),
        }
    }

    /// 使用默认配置创建
    pub fn with_url(url: &str) -> Self {
        let mut config = SocketConfig::default();
        config.url = url.to_string();
        Self::new(config)
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
        let url = format!("{}{}", self.config.url, self.config.namespace);
        info!("Connecting to {}", url);

        let connected = self.connected.clone();
        let event_tx = self.event_tx.clone();

        // 构建 TLS 连接器
        let tls_connector = self.build_tls_connector()?;

        // 构建客户端（使用 Any 让库自动选择最佳传输方式）
        let mut builder = ClientBuilder::new(&self.config.url)
            .namespace(&self.config.namespace)
            .transport_type(rust_socketio::TransportType::Any);

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
        if let Some(client) = self.client.write().await.take() {
            if let Err(e) = client.disconnect().await {
                error!("Disconnect error: {:?}", e);
            }
        }
        self.connected.store(false, Ordering::SeqCst);
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

    /// 上报在线
    pub async fn report_online(&self) -> Result<(), SocketError> {
        let data = OnlineData {
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        self.emit("daemon:online", serde_json::to_value(data).unwrap())
            .await
    }

    /// 上报离线
    pub async fn report_offline(&self) -> Result<(), SocketError> {
        let data = OfflineData {
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        self.emit("daemon:offline", serde_json::to_value(data).unwrap())
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
