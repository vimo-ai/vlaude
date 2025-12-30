//! Vlaude CLI - Daemon 命令行入口

use anyhow::Result;
use clap::Parser;
use daemon_logic::DaemonService;
use socket_client::{ServiceRegistryConfig, TlsConfig};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::signal;
use tokio::sync::watch;
use tracing::{info, warn, Level};
use tracing_subscriber::FmtSubscriber;

/// Vlaude Daemon CLI
#[derive(Parser, Debug)]
#[command(name = "vlaude")]
#[command(version, about = "Vlaude daemon for Claude Code session management")]
struct Args {
    /// Server URL (ignored if --redis-host is set)
    #[arg(short, long, default_value = "https://localhost:10005")]
    server: String,

    /// Device hostname
    #[arg(short = 'n', long, default_value_t = get_hostname())]
    hostname: String,

    /// Log level (trace, debug, info, warn, error)
    #[arg(short, long, default_value = "info")]
    log_level: String,

    /// CA certificate path for TLS
    #[arg(long)]
    ca_cert: Option<PathBuf>,

    /// Client certificate path for mTLS
    #[arg(long)]
    client_cert: Option<PathBuf>,

    /// Client key path for mTLS (not needed for P12)
    #[arg(long)]
    client_key: Option<PathBuf>,

    /// P12 password (for PKCS#12 format client cert)
    #[arg(long)]
    p12_password: Option<String>,

    /// Skip TLS certificate verification (DEVELOPMENT ONLY)
    #[arg(long, default_value = "false")]
    insecure: bool,

    // ==================== Redis Service Discovery ====================

    /// Redis host for service discovery
    #[arg(long)]
    redis_host: Option<String>,

    /// Redis port
    #[arg(long, default_value = "6379")]
    redis_port: u16,

    /// Redis password
    #[arg(long)]
    redis_password: Option<String>,
}

fn get_hostname() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // 初始化日志
    let level = match args.log_level.as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "info" => Level::INFO,
        "warn" => Level::WARN,
        "error" => Level::ERROR,
        _ => Level::INFO,
    };

    let subscriber = FmtSubscriber::builder().with_max_level(level).finish();
    tracing::subscriber::set_global_default(subscriber)?;

    info!("Starting Vlaude daemon...");
    info!("Hostname: {}", args.hostname);

    // 构建 TLS 配置
    let tls_config = TlsConfig {
        ca_cert_path: args.ca_cert,
        client_cert_path: args.client_cert,
        client_key_path: args.client_key,
        client_p12_password: args.p12_password,
        danger_accept_invalid_certs: args.insecure,
    };

    // 创建 shutdown 信号
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // 创建服务（根据是否有 Redis 配置）
    let service = if let Some(redis_host) = args.redis_host {
        info!("Using Redis service discovery: {}:{}", redis_host, args.redis_port);

        let redis_config = ServiceRegistryConfig {
            host: redis_host,
            port: args.redis_port,
            password: args.redis_password,
            key_prefix: "vlaude:".to_string(),
        };

        Arc::new(DaemonService::with_registry(&args.hostname, tls_config, redis_config).await?)
    } else {
        info!("Using direct server connection: {}", args.server);
        Arc::new(DaemonService::with_tls(&args.server, &args.hostname, tls_config)?)
    };

    // 启动服务
    service.start().await?;

    // 在后台运行事件循环
    let service_clone = service.clone();
    let mut shutdown_rx_clone = shutdown_rx.clone();
    let event_loop = tokio::spawn(async move {
        loop {
            tokio::select! {
                // 优先检查 shutdown 信号
                _ = shutdown_rx_clone.changed() => {
                    if *shutdown_rx_clone.borrow() {
                        info!("Event loop received shutdown signal");
                        break;
                    }
                }
                // 处理事件（run 内部会处理重连）
                result = service_clone.run_once() => {
                    if let Err(e) = result {
                        warn!("Event processing error: {:?}", e);
                    }
                }
            }
        }
    });

    // 等待 Ctrl+C
    info!("Daemon running. Press Ctrl+C to stop.");
    signal::ctrl_c().await?;
    info!("Received Ctrl+C, shutting down...");

    // 发送 shutdown 信号
    let _ = shutdown_tx.send(true);

    // 等待事件循环结束
    let _ = tokio::time::timeout(
        tokio::time::Duration::from_secs(5),
        event_loop,
    ).await;

    // 停止服务
    service.stop().await;

    info!("Daemon stopped");
    Ok(())
}
