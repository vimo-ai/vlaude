//! Vlaude FFI - C ABI 导出层
//!
//! 提供给 Swift/VlaudeKit 调用的 C 接口

use daemon_logic::DaemonService;
use std::ffi::{c_char, CStr, CString};
use std::ptr;
use std::sync::Arc;
use tokio::runtime::Runtime;
use tokio::sync::watch;

/// FFI 回调类型
pub type MobileViewingCallbackFn = extern "C" fn(*const c_char, bool);

/// FFI 安全的 Daemon 句柄
pub struct VlaudeDaemon {
    service: Arc<DaemonService>,
    runtime: Runtime,
    /// Shutdown 信号发送器
    shutdown_tx: Option<watch::Sender<bool>>,
    /// 事件循环任务句柄
    event_loop_handle: Option<tokio::task::JoinHandle<()>>,
}

/// 创建 Daemon 实例
///
/// # Safety
/// 调用者负责通过 `vlaude_destroy` 释放返回的指针
#[no_mangle]
pub unsafe extern "C" fn vlaude_create(
    server_url: *const c_char,
    hostname: *const c_char,
) -> *mut VlaudeDaemon {
    let url = if server_url.is_null() {
        // 从环境变量读取默认 URL
        let host = std::env::var("VLAUDE_SERVER_HOST").unwrap_or_else(|_| "localhost".to_string());
        let port = std::env::var("VLAUDE_SERVER_PORT").unwrap_or_else(|_| "10005".to_string());
        format!("https://{}:{}", host, port)
    } else {
        match CStr::from_ptr(server_url).to_str() {
            Ok(s) => s.to_string(),
            Err(_) => return ptr::null_mut(),
        }
    };

    let host = if hostname.is_null() {
        "ETerm".to_string()
    } else {
        match CStr::from_ptr(hostname).to_str() {
            Ok(s) => s.to_string(),
            Err(_) => return ptr::null_mut(),
        }
    };

    let runtime = match Runtime::new() {
        Ok(rt) => rt,
        Err(_) => return ptr::null_mut(),
    };

    let service = match DaemonService::new(&url, &host) {
        Ok(s) => Arc::new(s),
        Err(_) => return ptr::null_mut(),
    };

    let daemon = Box::new(VlaudeDaemon {
        service,
        runtime,
        shutdown_tx: None,
        event_loop_handle: None,
    });

    Box::into_raw(daemon)
}

/// 连接到服务器并启动事件循环
///
/// # Safety
/// `daemon` 必须是 `vlaude_create` 返回的有效指针
#[no_mangle]
pub unsafe extern "C" fn vlaude_connect(daemon: *mut VlaudeDaemon) -> bool {
    if daemon.is_null() {
        return false;
    }

    let daemon = &mut *daemon;

    // 启动服务
    let start_result = daemon
        .runtime
        .block_on(async { daemon.service.start().await });

    if start_result.is_err() {
        return false;
    }

    // 创建 shutdown 信号
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    daemon.shutdown_tx = Some(shutdown_tx);

    // 启动事件循环任务
    let service = daemon.service.clone();
    let handle = daemon.runtime.spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
                result = service.run_once() => {
                    if let Err(e) = result {
                        tracing::warn!("Event processing error: {:?}", e);
                    }
                }
            }
        }
    });
    daemon.event_loop_handle = Some(handle);

    true
}

/// 断开连接
///
/// # Safety
/// `daemon` 必须是 `vlaude_create` 返回的有效指针
#[no_mangle]
pub unsafe extern "C" fn vlaude_disconnect(daemon: *mut VlaudeDaemon) {
    if daemon.is_null() {
        return;
    }

    let daemon = &mut *daemon;

    // 发送 shutdown 信号
    if let Some(tx) = daemon.shutdown_tx.take() {
        let _ = tx.send(true);
    }

    // 等待事件循环结束
    if let Some(handle) = daemon.event_loop_handle.take() {
        let _ = daemon.runtime.block_on(async {
            tokio::time::timeout(
                tokio::time::Duration::from_secs(5),
                handle,
            ).await
        });
    }

    // 停止服务
    daemon.runtime.block_on(async {
        daemon.service.stop().await;
    });
}

/// 设置 Mobile 查看状态回调
///
/// # Safety
/// `daemon` 必须是有效指针
#[no_mangle]
pub unsafe extern "C" fn vlaude_set_mobile_viewing_callback(
    daemon: *mut VlaudeDaemon,
    callback: MobileViewingCallbackFn,
) {
    if daemon.is_null() {
        return;
    }

    let daemon = &*daemon;

    // 包装回调为 Rust 闘包
    let rust_callback: daemon_logic::MobileViewingCallback = Arc::new(
        move |session_id: &str, is_viewing: bool| {
            let c_session_id = CString::new(session_id).unwrap_or_default();
            callback(c_session_id.as_ptr(), is_viewing);
        },
    );

    daemon.runtime.block_on(async {
        daemon.service.set_mobile_viewing_callback(rust_callback).await;
    });
}

/// 释放 Daemon 实例
///
/// # Safety
/// `daemon` 必须是 `vlaude_create` 返回的有效指针，且只能调用一次
#[no_mangle]
pub unsafe extern "C" fn vlaude_destroy(daemon: *mut VlaudeDaemon) {
    if !daemon.is_null() {
        let _ = Box::from_raw(daemon);
    }
}

/// 获取版本号
///
/// # Safety
/// 返回的字符串是静态的，不需要释放
#[no_mangle]
pub extern "C" fn vlaude_version() -> *const c_char {
    static VERSION: &[u8] = concat!(env!("CARGO_PKG_VERSION"), "\0").as_bytes();
    VERSION.as_ptr() as *const c_char
}
