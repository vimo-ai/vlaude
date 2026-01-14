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

// ==================== ETerm 操作回调 FFI 类型 ====================

/// 创建会话结果 (FFI)
#[repr(C)]
pub struct CreateSessionResultFFI {
    pub success: bool,
    pub session_id: *mut c_char,
    pub project_path: *mut c_char,
    pub encoded_dir_name: *mut c_char,
    pub error: *mut c_char,
}

/// 发送消息结果 (FFI)
#[repr(C)]
pub struct SendMessageResultFFI {
    pub success: bool,
    pub error: *mut c_char,
    pub message_id: *mut c_char,
}

/// 创建会话回调 FFI 类型
/// 参数: (project_path, prompt, request_id)
/// 返回: CreateSessionResultFFI
pub type CreateSessionCallbackFn = extern "C" fn(*const c_char, *const c_char, *const c_char) -> CreateSessionResultFFI;

/// 发送消息回调 FFI 类型
/// 参数: (session_id, text, request_id)
/// 返回: SendMessageResultFFI
pub type SendMessageCallbackFn = extern "C" fn(*const c_char, *const c_char, *const c_char) -> SendMessageResultFFI;

/// 检查加载状态回调 FFI 类型
/// 参数: (session_id, request_id)
/// 返回: bool (is_loading)
pub type CheckLoadingCallbackFn = extern "C" fn(*const c_char, *const c_char) -> bool;

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

/// 设置创建会话回调 (ETerm)
///
/// # Safety
/// `daemon` 必须是有效指针
#[no_mangle]
pub unsafe extern "C" fn vlaude_set_create_session_callback(
    daemon: *mut VlaudeDaemon,
    callback: CreateSessionCallbackFn,
) {
    if daemon.is_null() {
        return;
    }

    let daemon = &*daemon;

    // 包装 FFI 回调为 Rust 闘包
    let rust_callback: daemon_logic::CreateSessionCallback = Arc::new(
        move |project_path: &str, prompt: Option<&str>, request_id: &str| {
            let c_project_path = CString::new(project_path).unwrap_or_default();
            let c_prompt = prompt.map(|p| CString::new(p).unwrap_or_default());
            let c_request_id = CString::new(request_id).unwrap_or_default();

            let result = callback(
                c_project_path.as_ptr(),
                c_prompt.as_ref().map(|p| p.as_ptr()).unwrap_or(ptr::null()),
                c_request_id.as_ptr(),
            );

            // 转换 FFI 结果为 Rust 结构
            daemon_logic::CreateSessionResult {
                success: result.success,
                session_id: if result.session_id.is_null() {
                    None
                } else {
                    let s = CStr::from_ptr(result.session_id).to_string_lossy().into_owned();
                    // 释放 FFI 返回的字符串
                    let _ = CString::from_raw(result.session_id);
                    Some(s)
                },
                project_path: if result.project_path.is_null() {
                    None
                } else {
                    let s = CStr::from_ptr(result.project_path).to_string_lossy().into_owned();
                    let _ = CString::from_raw(result.project_path);
                    Some(s)
                },
                encoded_dir_name: if result.encoded_dir_name.is_null() {
                    None
                } else {
                    let s = CStr::from_ptr(result.encoded_dir_name).to_string_lossy().into_owned();
                    let _ = CString::from_raw(result.encoded_dir_name);
                    Some(s)
                },
                error: if result.error.is_null() {
                    None
                } else {
                    let s = CStr::from_ptr(result.error).to_string_lossy().into_owned();
                    let _ = CString::from_raw(result.error);
                    Some(s)
                },
            }
        },
    );

    daemon.runtime.block_on(async {
        daemon.service.set_create_session_callback(rust_callback).await;
    });
}

/// 设置发送消息回调 (ETerm)
///
/// # Safety
/// `daemon` 必须是有效指针
#[no_mangle]
pub unsafe extern "C" fn vlaude_set_send_message_callback(
    daemon: *mut VlaudeDaemon,
    callback: SendMessageCallbackFn,
) {
    if daemon.is_null() {
        return;
    }

    let daemon = &*daemon;

    // 包装 FFI 回调为 Rust 闘包
    let rust_callback: daemon_logic::SendMessageCallback = Arc::new(
        move |session_id: &str, text: &str, request_id: &str| {
            let c_session_id = CString::new(session_id).unwrap_or_default();
            let c_text = CString::new(text).unwrap_or_default();
            let c_request_id = CString::new(request_id).unwrap_or_default();

            let result = callback(
                c_session_id.as_ptr(),
                c_text.as_ptr(),
                c_request_id.as_ptr(),
            );

            // 转换 FFI 结果为 Rust 结构
            daemon_logic::SendMessageResult {
                success: result.success,
                error: if result.error.is_null() {
                    None
                } else {
                    let s = CStr::from_ptr(result.error).to_string_lossy().into_owned();
                    let _ = CString::from_raw(result.error);
                    Some(s)
                },
                message_id: if result.message_id.is_null() {
                    None
                } else {
                    let s = CStr::from_ptr(result.message_id).to_string_lossy().into_owned();
                    let _ = CString::from_raw(result.message_id);
                    Some(s)
                },
            }
        },
    );

    daemon.runtime.block_on(async {
        daemon.service.set_send_message_callback(rust_callback).await;
    });
}

/// 设置检查加载状态回调 (ETerm)
///
/// # Safety
/// `daemon` 必须是有效指针
#[no_mangle]
pub unsafe extern "C" fn vlaude_set_check_loading_callback(
    daemon: *mut VlaudeDaemon,
    callback: CheckLoadingCallbackFn,
) {
    if daemon.is_null() {
        return;
    }

    let daemon = &*daemon;

    // 包装 FFI 回调为 Rust 闘包
    let rust_callback: daemon_logic::CheckLoadingCallback = Arc::new(
        move |session_id: &str, request_id: &str| {
            let c_session_id = CString::new(session_id).unwrap_or_default();
            let c_request_id = CString::new(request_id).unwrap_or_default();

            callback(c_session_id.as_ptr(), c_request_id.as_ptr())
        },
    );

    daemon.runtime.block_on(async {
        daemon.service.set_check_loading_callback(rust_callback).await;
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

// ==================== 数据查询 FFI API ====================

/// 释放 FFI 返回的字符串
///
/// # Safety
/// `ptr` 必须是本模块 FFI 函数返回的有效指针，且只能调用一次
#[no_mangle]
pub unsafe extern "C" fn vlaude_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = CString::from_raw(ptr);
    }
}

/// 辅助函数：将 JSON 字符串转换为 C 字符串
fn json_to_c_string(json: serde_json::Value) -> *mut c_char {
    match serde_json::to_string(&json) {
        Ok(s) => match CString::new(s) {
            Ok(c) => c.into_raw(),
            Err(_) => ptr::null_mut(),
        },
        Err(_) => ptr::null_mut(),
    }
}

/// 辅助函数：创建错误 JSON 响应
fn error_response(message: &str) -> *mut c_char {
    let json = serde_json::json!({
        "error": message
    });
    json_to_c_string(json)
}

/// 列出所有项目（带统计信息）
///
/// 返回 JSON 字符串，格式：
/// ```json
/// {
///   "projects": [
///     {
///       "id": 1,
///       "name": "project-name",
///       "path": "/path/to/project",
///       "session_count": 10,
///       "message_count": 100,
///       "last_activity_at": "2024-01-01T00:00:00Z"
///     }
///   ]
/// }
/// ```
///
/// # Safety
/// 返回的字符串必须通过 `vlaude_free_string` 释放
#[no_mangle]
pub extern "C" fn vlaude_list_projects(limit: u32, offset: u32) -> *mut c_char {
    match daemon_logic::sync_api::list_projects(limit as usize, offset as usize) {
        Ok(projects) => {
            let json = serde_json::json!({
                "projects": projects
            });
            json_to_c_string(json)
        }
        Err(e) => error_response(&format!("Query failed: {}", e)),
    }
}

/// 列出指定项目的会话
///
/// # Arguments
/// * `project_path` - 项目路径（C 字符串）
///
/// 返回 JSON 字符串，格式：
/// ```json
/// {
///   "sessions": [
///     {
///       "session_id": "abc123",
///       "project_id": 1,
///       "project_path": "/path/to/project",
///       "project_name": "project-name",
///       "message_count": 50,
///       "created_at": "2024-01-01T00:00:00Z",
///       "updated_at": "2024-01-02T00:00:00Z"
///     }
///   ]
/// }
/// ```
///
/// # Safety
/// - `project_path` 必须是有效的 UTF-8 C 字符串
/// - 返回的字符串必须通过 `vlaude_free_string` 释放
#[no_mangle]
pub unsafe extern "C" fn vlaude_list_sessions(project_path: *const c_char, limit: u32, offset: u32) -> *mut c_char {
    if project_path.is_null() {
        return error_response("project_path is null");
    }

    let path = match CStr::from_ptr(project_path).to_str() {
        Ok(s) => s,
        Err(_) => return error_response("Invalid UTF-8 in project_path"),
    };

    match daemon_logic::sync_api::list_sessions(path, limit as usize, offset as usize) {
        Ok(sessions) => {
            let json = serde_json::json!({
                "sessions": sessions
            });
            json_to_c_string(json)
        }
        Err(e) => error_response(&format!("Query failed: {}", e)),
    }
}

/// 获取会话消息
///
/// # Arguments
/// * `session_id` - 会话 ID（C 字符串）
/// * `limit` - 返回消息数量限制
/// * `offset` - 偏移量（分页）
///
/// 返回 JSON 字符串，格式：
/// ```json
/// {
///   "messages": [
///     {
///       "id": 1,
///       "uuid": "msg-uuid",
///       "type": "user",
///       "content_text": "Hello",
///       "timestamp": 1704067200000
///     }
///   ]
/// }
/// ```
///
/// # Safety
/// - `session_id` 必须是有效的 UTF-8 C 字符串
/// - 返回的字符串必须通过 `vlaude_free_string` 释放
#[no_mangle]
pub unsafe extern "C" fn vlaude_get_messages(
    session_id: *const c_char,
    limit: u32,
    offset: u32,
) -> *mut c_char {
    if session_id.is_null() {
        return error_response("session_id is null");
    }

    let sid = match CStr::from_ptr(session_id).to_str() {
        Ok(s) => s,
        Err(_) => return error_response("Invalid UTF-8 in session_id"),
    };

    match daemon_logic::sync_api::get_messages(sid, limit as usize, offset as usize) {
        Ok(messages) => {
            // 序列化消息为 JSON Value
            let mut messages_json: Vec<serde_json::Value> = messages
                .into_iter()
                .filter_map(|m| serde_json::to_value(m).ok())
                .collect();

            // 为每条消息添加 contentBlocks（从 raw 字段解析）
            daemon_logic::enrich_messages_with_content_blocks(&mut messages_json);

            let json = serde_json::json!({
                "messages": messages_json
            });
            json_to_c_string(json)
        }
        Err(e) => error_response(&format!("Query failed: {}", e)),
    }
}

/// 全文搜索
///
/// # Arguments
/// * `query` - 搜索关键词（C 字符串）
/// * `limit` - 返回结果数量限制
///
/// 返回 JSON 字符串，格式：
/// ```json
/// {
///   "results": [
///     {
///       "message_id": 1,
///       "session_id": "abc123",
///       "project_path": "/path/to/project",
///       "content_text": "matched content...",
///       "snippet": "...highlighted snippet...",
///       "rank": 0.95
///     }
///   ]
/// }
/// ```
///
/// # Safety
/// - `query` 必须是有效的 UTF-8 C 字符串
/// - 返回的字符串必须通过 `vlaude_free_string` 释放
#[no_mangle]
pub unsafe extern "C" fn vlaude_search(query: *const c_char, limit: u32) -> *mut c_char {
    if query.is_null() {
        return error_response("query is null");
    }

    let q = match CStr::from_ptr(query).to_str() {
        Ok(s) => s,
        Err(_) => return error_response("Invalid UTF-8 in query"),
    };

    match daemon_logic::sync_api::search(q, limit as usize) {
        Ok(results) => {
            let json = serde_json::json!({
                "results": results
            });
            json_to_c_string(json)
        }
        Err(e) => error_response(&format!("Search failed: {}", e)),
    }
}

/// 获取数据库统计信息
///
/// 返回 JSON 字符串，格式：
/// ```json
/// {
///   "project_count": 10,
///   "session_count": 100,
///   "message_count": 5000
/// }
/// ```
///
/// # Safety
/// 返回的字符串必须通过 `vlaude_free_string` 释放
#[no_mangle]
pub extern "C" fn vlaude_get_stats() -> *mut c_char {
    match daemon_logic::sync_api::get_stats() {
        Ok(stats) => {
            let json = serde_json::to_value(stats).unwrap_or(serde_json::json!({}));
            json_to_c_string(json)
        }
        Err(e) => error_response(&format!("Query failed: {}", e)),
    }
}
