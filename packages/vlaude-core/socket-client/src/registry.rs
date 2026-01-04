//! Redis 服务注册中心
//!
//! 用于服务发现和管理，解决 Server 重启后各组件自动重连的问题

use anyhow::{Context, Result};
use redis::aio::MultiplexedConnection;
use redis::{AsyncCommands, Client};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tracing::{debug, error, info, warn};

/// 服务事件类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceEventType {
    Online,
    Offline,
    SessionUpdate,
}

/// 服务事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceEvent {
    #[serde(rename = "type")]
    pub event_type: ServiceEventType,
    pub service: String,
    /// Server 使用 address，Daemon 使用 device_id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// session_update 事件携带的 session 列表
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Vec<SessionInfo>>,
    pub timestamp: u64,
}

/// 服务信息（用于 Server）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceInfo {
    pub address: String,
    pub ttl: u64,
    #[serde(rename = "registeredAt")]
    pub registered_at: u64,
}

/// Session 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "projectPath")]
    pub project_path: String,
}

/// Daemon 信息（用于 VlaudeKit / vlaude-daemon-rs）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonInfo {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "deviceName")]
    pub device_name: String,
    pub platform: String,
    pub version: String,
    /// 当前打开的 session 列表
    #[serde(default)]
    pub sessions: Vec<SessionInfo>,
    #[serde(rename = "registeredAt")]
    pub registered_at: u64,
}

/// Redis 服务注册中心配置
#[derive(Debug, Clone)]
pub struct ServiceRegistryConfig {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
    pub key_prefix: String,
}

impl Default for ServiceRegistryConfig {
    fn default() -> Self {
        Self {
            // 从环境变量读取，默认 localhost
            host: std::env::var("REDIS_HOST").unwrap_or_else(|_| "localhost".to_string()),
            port: std::env::var("REDIS_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(6379),
            password: std::env::var("REDIS_PASSWORD").ok(),
            key_prefix: "vlaude:".to_string(),
        }
    }
}

/// Redis 服务注册中心
pub struct ServiceRegistry {
    client: Client,
    conn: Arc<RwLock<Option<MultiplexedConnection>>>,
    config: ServiceRegistryConfig,
    channel: String,
    event_tx: broadcast::Sender<ServiceEvent>,
}

impl ServiceRegistry {
    /// 创建服务注册中心
    pub fn new(config: ServiceRegistryConfig) -> Result<Self> {
        let url = if let Some(ref password) = config.password {
            format!("redis://:{}@{}:{}", password, config.host, config.port)
        } else {
            format!("redis://{}:{}", config.host, config.port)
        };

        let client = Client::open(url).context("Failed to create Redis client")?;
        let channel = format!("{}channel:service-registry", config.key_prefix);
        let (event_tx, _) = broadcast::channel(16);

        Ok(Self {
            client,
            conn: Arc::new(RwLock::new(None)),
            config,
            channel,
            event_tx,
        })
    }

    /// 连接 Redis
    pub async fn connect(&self) -> Result<()> {
        let conn = self
            .client
            .get_multiplexed_async_connection()
            .await
            .context("Failed to connect to Redis")?;

        *self.conn.write().await = Some(conn);
        info!(
            "[ServiceRegistry] Connected to Redis at {}:{}",
            self.config.host, self.config.port
        );

        Ok(())
    }

    /// 获取连接
    async fn get_conn(&self) -> Result<MultiplexedConnection> {
        let guard = self.conn.read().await;
        guard
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Not connected to Redis"))
    }

    /// 构建服务 Key
    fn build_service_key(&self, service: &str, address: &str) -> String {
        format!("{}services:{}:{}", self.config.key_prefix, service, address)
    }

    /// 注册服务（用于 Server）
    pub async fn register(&self, service: &str, address: &str, ttl: u64) -> Result<()> {
        let mut conn = self.get_conn().await?;
        let key = self.build_service_key(service, address);

        let info = ServiceInfo {
            address: address.to_string(),
            ttl,
            registered_at: chrono::Utc::now().timestamp_millis() as u64,
        };
        let value = serde_json::to_string(&info)?;

        conn.set_ex::<_, _, ()>(&key, &value, ttl)
            .await
            .context("Failed to register service")?;

        info!(
            "[ServiceRegistry] Registered: {}@{} (TTL: {}s)",
            service, address, ttl
        );

        // 发布 online 事件
        self.publish_event(ServiceEvent {
            event_type: ServiceEventType::Online,
            service: service.to_string(),
            address: Some(address.to_string()),
            device_id: None,
            sessions: None,
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
        })
        .await?;

        Ok(())
    }

    /// 注销服务（用于 Server）
    pub async fn unregister(&self, service: &str, address: &str) -> Result<()> {
        let mut conn = self.get_conn().await?;
        let key = self.build_service_key(service, address);

        conn.del::<_, ()>(&key)
            .await
            .context("Failed to unregister service")?;

        info!("[ServiceRegistry] Unregistered: {}@{}", service, address);

        // 发布 offline 事件
        self.publish_event(ServiceEvent {
            event_type: ServiceEventType::Offline,
            service: service.to_string(),
            address: Some(address.to_string()),
            device_id: None,
            sessions: None,
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
        })
        .await?;

        Ok(())
    }

    // ==================== Daemon 相关方法 ====================

    /// 构建 Daemon Key
    fn build_daemon_key(&self, device_id: &str) -> String {
        format!("{}services:daemon:{}", self.config.key_prefix, device_id)
    }

    /// 注册 Daemon（用于 VlaudeKit / vlaude-daemon-rs）
    pub async fn register_daemon(&self, info: &DaemonInfo, ttl: u64) -> Result<()> {
        let mut conn = self.get_conn().await?;
        let key = self.build_daemon_key(&info.device_id);

        let value = serde_json::to_string(info)?;

        conn.set_ex::<_, _, ()>(&key, &value, ttl)
            .await
            .context("Failed to register daemon")?;

        info!(
            "[ServiceRegistry] Daemon registered: {} ({}) (TTL: {}s)",
            info.device_id, info.device_name, ttl
        );

        // 发布 online 事件
        self.publish_event(ServiceEvent {
            event_type: ServiceEventType::Online,
            service: "daemon".to_string(),
            address: None,
            device_id: Some(info.device_id.clone()),
            sessions: Some(info.sessions.clone()),
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
        })
        .await?;

        Ok(())
    }

    /// 注销 Daemon
    pub async fn unregister_daemon(&self, device_id: &str) -> Result<()> {
        let mut conn = self.get_conn().await?;
        let key = self.build_daemon_key(device_id);

        conn.del::<_, ()>(&key)
            .await
            .context("Failed to unregister daemon")?;

        info!("[ServiceRegistry] Daemon unregistered: {}", device_id);

        // 发布 offline 事件
        self.publish_event(ServiceEvent {
            event_type: ServiceEventType::Offline,
            service: "daemon".to_string(),
            address: None,
            device_id: Some(device_id.to_string()),
            sessions: None,
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
        })
        .await?;

        Ok(())
    }

    /// 续期 Daemon
    pub async fn keep_alive_daemon(&self, device_id: &str, ttl: u64) -> Result<()> {
        let mut conn = self.get_conn().await?;
        let key = self.build_daemon_key(device_id);

        let exists: bool = conn.exists(&key).await?;
        if exists {
            conn.expire::<_, ()>(&key, ttl as i64).await?;
            debug!("[ServiceRegistry] Daemon keep-alive: {}", device_id);
        } else {
            warn!(
                "[ServiceRegistry] Daemon {} not found, need re-register",
                device_id
            );
            return Err(anyhow::anyhow!("Daemon not found, need re-register"));
        }

        Ok(())
    }

    /// 更新 Daemon 的 Session 列表
    pub async fn update_daemon_sessions(
        &self,
        device_id: &str,
        sessions: Vec<SessionInfo>,
        ttl: u64,
    ) -> Result<()> {
        let mut conn = self.get_conn().await?;
        let key = self.build_daemon_key(device_id);

        // 读取现有 daemon 信息
        let value: Option<String> = conn.get(&key).await?;
        let mut info: DaemonInfo = match value {
            Some(v) => serde_json::from_str(&v)?,
            None => return Err(anyhow::anyhow!("Daemon not found")),
        };

        // 更新 sessions
        info.sessions = sessions.clone();

        // 写回
        let new_value = serde_json::to_string(&info)?;
        conn.set_ex::<_, _, ()>(&key, &new_value, ttl)
            .await
            .context("Failed to update daemon sessions")?;

        debug!(
            "[ServiceRegistry] Daemon {} sessions updated: {} sessions",
            device_id,
            sessions.len()
        );

        // 发布 session_update 事件
        self.publish_event(ServiceEvent {
            event_type: ServiceEventType::SessionUpdate,
            service: "daemon".to_string(),
            address: None,
            device_id: Some(device_id.to_string()),
            sessions: Some(sessions),
            timestamp: chrono::Utc::now().timestamp_millis() as u64,
        })
        .await?;

        Ok(())
    }

    /// 获取所有 Daemon
    pub async fn get_daemons(&self) -> Result<Vec<DaemonInfo>> {
        let mut conn = self.get_conn().await?;
        let pattern = format!("{}services:daemon:*", self.config.key_prefix);

        let keys: Vec<String> = redis::cmd("KEYS")
            .arg(&pattern)
            .query_async(&mut conn)
            .await
            .context("Failed to get daemon keys")?;

        if keys.is_empty() {
            return Ok(vec![]);
        }

        let mut daemons = Vec::new();
        for key in keys {
            if let Ok(value) = conn.get::<_, Option<String>>(&key).await {
                if let Some(value) = value {
                    if let Ok(info) = serde_json::from_str::<DaemonInfo>(&value) {
                        daemons.push(info);
                    }
                }
            }
        }

        Ok(daemons)
    }

    /// 获取指定 Daemon
    pub async fn get_daemon(&self, device_id: &str) -> Result<Option<DaemonInfo>> {
        let mut conn = self.get_conn().await?;
        let key = self.build_daemon_key(device_id);

        let value: Option<String> = conn.get(&key).await?;
        match value {
            Some(v) => Ok(Some(serde_json::from_str(&v)?)),
            None => Ok(None),
        }
    }

    /// 续期服务
    pub async fn keep_alive(&self, service: &str, address: &str, ttl: u64) -> Result<()> {
        let mut conn = self.get_conn().await?;
        let key = self.build_service_key(service, address);

        let exists: bool = conn.exists(&key).await?;
        if exists {
            conn.expire::<_, ()>(&key, ttl as i64).await?;
        } else {
            // Key 不存在，重新注册
            self.register(service, address, ttl).await?;
        }

        Ok(())
    }

    /// 获取所有 Server，按优先级排序
    pub async fn get_servers(&self) -> Result<Vec<String>> {
        let mut conn = self.get_conn().await?;
        let pattern = self.build_service_key("server", "*");

        let keys: Vec<String> = redis::cmd("KEYS")
            .arg(&pattern)
            .query_async(&mut conn)
            .await
            .context("Failed to get server keys")?;

        if keys.is_empty() {
            return Ok(vec![]);
        }

        let mut addresses = Vec::new();
        for key in keys {
            if let Ok(value) = conn.get::<_, Option<String>>(&key).await {
                if let Some(value) = value {
                    if let Ok(info) = serde_json::from_str::<ServiceInfo>(&value) {
                        addresses.push(info.address);
                    }
                }
            }
        }

        // 按优先级排序
        self.sort_by_priority(&mut addresses);

        Ok(addresses)
    }

    /// 订阅服务事件
    pub fn subscribe(&self) -> broadcast::Receiver<ServiceEvent> {
        self.event_tx.subscribe()
    }

    /// 启动事件监听（在后台 task 中运行）
    pub async fn start_listening(&self) -> Result<()> {
        let client = self.client.clone();
        let channel = self.channel.clone();
        let event_tx = self.event_tx.clone();

        tokio::spawn(async move {
            loop {
                match client.get_async_pubsub().await {
                    Ok(mut pubsub) => {
                        if let Err(e) = pubsub.subscribe(&channel).await {
                            error!("[ServiceRegistry] Subscribe failed: {}", e);
                            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                            continue;
                        }

                        info!("[ServiceRegistry] Subscribed to {}", channel);

                        loop {
                            match pubsub.on_message().next().await {
                                Some(msg) => {
                                    if let Ok(payload) = msg.get_payload::<String>() {
                                        if let Ok(event) =
                                            serde_json::from_str::<ServiceEvent>(&payload)
                                        {
                                            debug!("[ServiceRegistry] Event: {:?}", event);
                                            let _ = event_tx.send(event);
                                        }
                                    }
                                }
                                None => {
                                    warn!("[ServiceRegistry] PubSub connection closed");
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        error!("[ServiceRegistry] PubSub connection failed: {}", e);
                        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    }
                }
            }
        });

        Ok(())
    }

    /// 发布事件
    async fn publish_event(&self, event: ServiceEvent) -> Result<()> {
        let mut conn = self.get_conn().await?;
        let payload = serde_json::to_string(&event)?;

        conn.publish::<_, _, ()>(&self.channel, &payload)
            .await
            .context("Failed to publish event")?;

        Ok(())
    }

    /// 按优先级排序
    /// 1. localhost:* 最高
    /// 2. 192.168.*:* 次之
    /// 3. 域名最低
    fn sort_by_priority(&self, addresses: &mut Vec<String>) {
        addresses.sort_by(|a, b| {
            let priority_a = self.get_priority(a);
            let priority_b = self.get_priority(b);
            priority_b.cmp(&priority_a) // 降序
        });
    }

    fn get_priority(&self, address: &str) -> u8 {
        let host = address.split(':').next().unwrap_or("");

        if host == "localhost" || host == "127.0.0.1" {
            return 3;
        }

        if host.starts_with("192.168.")
            || host.starts_with("10.")
            || host.starts_with("172.")
        {
            return 2;
        }

        1
    }

    /// 断开连接
    pub async fn disconnect(&self) {
        *self.conn.write().await = None;
        info!("[ServiceRegistry] Disconnected");
    }
}

use futures::StreamExt;
