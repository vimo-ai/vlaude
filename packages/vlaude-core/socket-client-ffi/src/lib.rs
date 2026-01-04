//! Socket Client FFI - C ABI 导出层
//!
//! 为 VlaudeKit (Swift) 提供 socket-client 的 C 接口
//!
//! 设计原则：
//! - VlaudeKit 使用此 FFI 处理 Socket 连接和数据同步
//! - ETerm 特有逻辑（createSession, sendMessage 等）保留在 Swift 层

use socket_client::{
    DaemonRegistration, ServiceRegistryConfig, SessionInfo, SocketClient, SocketConfig, TlsConfig,
};
use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{self, AssertUnwindSafe};
use std::sync::Arc;
use tokio::runtime::Runtime;
use tokio::sync::RwLock;

// ==================== 错误码 ====================

/// FFI 错误码
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketClientError {
    Success = 0,
    NullPointer = 1,
    InvalidUtf8 = 2,
    ConnectionFailed = 3,
    NotConnected = 4,
    EmitFailed = 5,
    RuntimeError = 6,
    RegistryError = 7,
    Unknown = 99,
}

// ==================== 句柄 ====================

/// 不透明句柄
pub struct SocketClientHandle {
    client: Arc<SocketClient>,
    runtime: Arc<Runtime>,
    /// 事件回调（下行事件）
    event_callback: Arc<RwLock<Option<EventCallback>>>,
}

/// 事件回调类型
type EventCallbackFn = extern "C" fn(event: *const c_char, data: *const c_char, user_data: *mut c_void);

struct EventCallback {
    callback: EventCallbackFn,
    user_data: *mut c_void,
}

// 允许跨线程传递
unsafe impl Send for EventCallback {}
unsafe impl Sync for EventCallback {}

// ==================== 创建/销毁 ====================

/// 创建 Socket 客户端
///
/// # Safety
/// - `url` 必须是有效的 UTF-8 C 字符串（如 "https://localhost:10005"）
/// - `namespace` 必须是有效的 UTF-8 C 字符串（如 "/daemon"），可为 null 使用默认值
/// - 返回的句柄需要通过 `socket_client_destroy` 释放
#[no_mangle]
pub unsafe extern "C" fn socket_client_create(
    url: *const c_char,
    namespace: *const c_char,
    out_handle: *mut *mut SocketClientHandle,
) -> SocketClientError {
    if url.is_null() || out_handle.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let url_str = CStr::from_ptr(url)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        let namespace_str = if namespace.is_null() {
            "/daemon".to_string()
        } else {
            CStr::from_ptr(namespace)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?
                .to_string()
        };

        // 创建 TLS 配置（开发模式：跳过证书验证）
        let tls = TlsConfig {
            danger_accept_invalid_certs: true,
            ..Default::default()
        };

        let config = SocketConfig {
            url: url_str.to_string(),
            namespace: namespace_str,
            tls,
            redis: None,
            daemon_info: None,
        };

        let runtime = Runtime::new().map_err(|_| SocketClientError::RuntimeError)?;
        let client = SocketClient::new(config);

        Ok(SocketClientHandle {
            client: Arc::new(client),
            runtime: Arc::new(runtime),
            event_callback: Arc::new(RwLock::new(None)),
        })
    }));

    match result {
        Ok(Ok(handle)) => {
            *out_handle = Box::into_raw(Box::new(handle));
            SocketClientError::Success
        }
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

/// 销毁 Socket 客户端
///
/// # Safety
/// - `handle` 必须是 `socket_client_create` 返回的有效句柄
/// - 调用后句柄不再有效
#[no_mangle]
pub unsafe extern "C" fn socket_client_destroy(handle: *mut SocketClientHandle) {
    if !handle.is_null() {
        let handle = Box::from_raw(handle);
        // 断开连接
        handle.runtime.block_on(async {
            handle.client.disconnect().await;
        });
        // handle 自动 drop
    }
}

// ==================== 连接管理 ====================

/// 连接到服务器
///
/// # Safety
/// - `handle` 必须是有效句柄
#[no_mangle]
pub unsafe extern "C" fn socket_client_connect(handle: *mut SocketClientHandle) -> SocketClientError {
    if handle.is_null() {
        return SocketClientError::NullPointer;
    }

    let handle = &*handle;
    let result = handle.runtime.block_on(async {
        handle.client.connect().await
    });

    match result {
        Ok(_) => {
            // 启动事件接收循环
            start_event_loop(handle);
            SocketClientError::Success
        }
        Err(_) => SocketClientError::ConnectionFailed,
    }
}

/// 断开连接
///
/// # Safety
/// - `handle` 必须是有效句柄
#[no_mangle]
pub unsafe extern "C" fn socket_client_disconnect(handle: *mut SocketClientHandle) {
    if handle.is_null() {
        return;
    }

    let handle = &*handle;
    handle.runtime.block_on(async {
        handle.client.disconnect().await;
    });
}

/// 检查是否已连接
///
/// # Safety
/// - `handle` 必须是有效句柄
#[no_mangle]
pub unsafe extern "C" fn socket_client_is_connected(handle: *const SocketClientHandle) -> bool {
    if handle.is_null() {
        return false;
    }

    let handle = &*handle;
    handle.client.is_connected()
}

// ==================== 事件回调 ====================

/// 设置事件回调
///
/// 当收到服务器下行事件时，会调用此回调
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `callback` 在整个句柄生命周期内必须有效
/// - `user_data` 可为 null
#[no_mangle]
pub unsafe extern "C" fn socket_client_set_event_callback(
    handle: *mut SocketClientHandle,
    callback: EventCallbackFn,
    user_data: *mut c_void,
) {
    if handle.is_null() {
        return;
    }

    let handle = &*handle;
    handle.runtime.block_on(async {
        let mut cb = handle.event_callback.write().await;
        *cb = Some(EventCallback { callback, user_data });
    });
}

/// 启动事件接收循环
fn start_event_loop(handle: &SocketClientHandle) {
    let client = handle.client.clone();
    let callback_holder = handle.event_callback.clone();

    handle.runtime.spawn(async move {
        loop {
            if let Some((event, data)) = client.recv_event().await {
                let callback = callback_holder.read().await;
                if let Some(ref cb) = *callback {
                    // 转换为 C 字符串
                    if let (Ok(event_c), Ok(data_c)) = (
                        CString::new(event.clone()),
                        CString::new(data.to_string()),
                    ) {
                        (cb.callback)(event_c.as_ptr(), data_c.as_ptr(), cb.user_data);
                    }
                }

                // 检查是否断开
                if event == "__disconnected" {
                    break;
                }
            }
        }
    });
}

// ==================== 上行事件 ====================

/// 发送事件
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `event` 和 `json_data` 必须是有效的 UTF-8 C 字符串
#[no_mangle]
pub unsafe extern "C" fn socket_client_emit(
    handle: *mut SocketClientHandle,
    event: *const c_char,
    json_data: *const c_char,
) -> SocketClientError {
    if handle.is_null() || event.is_null() || json_data.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let event_str = CStr::from_ptr(event)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;
        let data_str = CStr::from_ptr(json_data)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;
        let data: serde_json::Value = serde_json::from_str(data_str)
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        handle.runtime.block_on(async {
            handle.client.emit(event_str, data).await
        }).map_err(|_| SocketClientError::EmitFailed)
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

/// 注册 daemon
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `hostname`, `platform`, `version` 必须是有效的 UTF-8 C 字符串
#[no_mangle]
pub unsafe extern "C" fn socket_client_register(
    handle: *mut SocketClientHandle,
    hostname: *const c_char,
    platform: *const c_char,
    version: *const c_char,
) -> SocketClientError {
    if handle.is_null() || hostname.is_null() || platform.is_null() || version.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let hostname_str = CStr::from_ptr(hostname)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;
        let platform_str = CStr::from_ptr(platform)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;
        let version_str = CStr::from_ptr(version)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        let data = socket_client::RegisterData {
            hostname: hostname_str.to_string(),
            platform: platform_str.to_string(),
            version: version_str.to_string(),
        };

        handle.runtime.block_on(async {
            handle.client.register(data).await
        }).map_err(|_| SocketClientError::EmitFailed)?;

        Ok(())
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

/// 上报在线状态
///
/// # Safety
/// - `handle` 必须是有效句柄
#[no_mangle]
pub unsafe extern "C" fn socket_client_report_online(handle: *mut SocketClientHandle) -> SocketClientError {
    if handle.is_null() {
        return SocketClientError::NullPointer;
    }

    let handle = &*handle;
    let result = handle.runtime.block_on(async {
        handle.client.report_online().await
    });

    match result {
        Ok(_) => SocketClientError::Success,
        Err(_) => SocketClientError::EmitFailed,
    }
}

/// 上报离线状态
///
/// # Safety
/// - `handle` 必须是有效句柄
#[no_mangle]
pub unsafe extern "C" fn socket_client_report_offline(handle: *mut SocketClientHandle) -> SocketClientError {
    if handle.is_null() {
        return SocketClientError::NullPointer;
    }

    let handle = &*handle;
    let result = handle.runtime.block_on(async {
        handle.client.report_offline().await
    });

    match result {
        Ok(_) => SocketClientError::Success,
        Err(_) => SocketClientError::EmitFailed,
    }
}

/// 上报项目数据
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `projects_json` 必须是有效的 JSON 数组字符串
/// - `request_id` 可为 null
#[no_mangle]
pub unsafe extern "C" fn socket_client_report_project_data(
    handle: *mut SocketClientHandle,
    projects_json: *const c_char,
    request_id: *const c_char,
) -> SocketClientError {
    if handle.is_null() || projects_json.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let projects_str = CStr::from_ptr(projects_json)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;
        let projects: Vec<serde_json::Value> = serde_json::from_str(projects_str)
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        let req_id = if request_id.is_null() {
            None
        } else {
            Some(CStr::from_ptr(request_id)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?
                .to_string())
        };

        handle.runtime.block_on(async {
            handle.client.report_project_data(projects, req_id).await
        }).map_err(|_| SocketClientError::EmitFailed)
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

/// 上报会话元数据
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `sessions_json` 必须是有效的 JSON 数组字符串
/// - `project_path` 和 `request_id` 可为 null
#[no_mangle]
pub unsafe extern "C" fn socket_client_report_session_metadata(
    handle: *mut SocketClientHandle,
    sessions_json: *const c_char,
    project_path: *const c_char,
    request_id: *const c_char,
) -> SocketClientError {
    if handle.is_null() || sessions_json.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let sessions_str = CStr::from_ptr(sessions_json)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;
        let sessions: Vec<serde_json::Value> = serde_json::from_str(sessions_str)
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        let proj_path = if project_path.is_null() {
            None
        } else {
            Some(CStr::from_ptr(project_path)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?
                .to_string())
        };

        let req_id = if request_id.is_null() {
            None
        } else {
            Some(CStr::from_ptr(request_id)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?
                .to_string())
        };

        handle.runtime.block_on(async {
            handle.client.report_session_metadata(sessions, proj_path, req_id).await
        }).map_err(|_| SocketClientError::EmitFailed)
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

/// 上报会话消息
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `session_id`, `project_path`, `messages_json` 必须是有效字符串
/// - `request_id` 可为 null
#[no_mangle]
pub unsafe extern "C" fn socket_client_report_session_messages(
    handle: *mut SocketClientHandle,
    session_id: *const c_char,
    project_path: *const c_char,
    messages_json: *const c_char,
    total: usize,
    has_more: bool,
    request_id: *const c_char,
) -> SocketClientError {
    if handle.is_null() || session_id.is_null() || project_path.is_null() || messages_json.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let sid = CStr::from_ptr(session_id)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?
            .to_string();
        let ppath = CStr::from_ptr(project_path)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?
            .to_string();
        let messages_str = CStr::from_ptr(messages_json)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;
        let messages: Vec<serde_json::Value> = serde_json::from_str(messages_str)
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        let req_id = if request_id.is_null() {
            None
        } else {
            Some(CStr::from_ptr(request_id)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?
                .to_string())
        };

        handle.runtime.block_on(async {
            handle.client.report_session_messages(sid, ppath, messages, total, has_more, req_id).await
        }).map_err(|_| SocketClientError::EmitFailed)
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

/// 上报新消息
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `session_id` 和 `message_json` 必须是有效字符串
#[no_mangle]
pub unsafe extern "C" fn socket_client_notify_new_message(
    handle: *mut SocketClientHandle,
    session_id: *const c_char,
    message_json: *const c_char,
) -> SocketClientError {
    if handle.is_null() || session_id.is_null() || message_json.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let sid = CStr::from_ptr(session_id)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;
        let msg_str = CStr::from_ptr(message_json)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;
        let message: serde_json::Value = serde_json::from_str(msg_str)
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        handle.runtime.block_on(async {
            handle.client.notify_new_message(sid, message).await
        }).map_err(|_| SocketClientError::EmitFailed)
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

/// 上报项目更新
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `project_path` 必须是有效字符串
/// - `metadata_json` 可为 null
#[no_mangle]
pub unsafe extern "C" fn socket_client_notify_project_update(
    handle: *mut SocketClientHandle,
    project_path: *const c_char,
    metadata_json: *const c_char,
) -> SocketClientError {
    if handle.is_null() || project_path.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let ppath = CStr::from_ptr(project_path)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        let metadata = if metadata_json.is_null() {
            None
        } else {
            let meta_str = CStr::from_ptr(metadata_json)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?;
            Some(serde_json::from_str(meta_str)
                .map_err(|_| SocketClientError::InvalidUtf8)?)
        };

        handle.runtime.block_on(async {
            handle.client.notify_project_update(ppath, metadata).await
        }).map_err(|_| SocketClientError::EmitFailed)
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

// ==================== V3 写操作响应 ====================

/// 发送会话创建结果
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `request_id` 必须是有效字符串
/// - 其他字符串参数可为 null
#[no_mangle]
pub unsafe extern "C" fn socket_client_send_session_created_result(
    handle: *mut SocketClientHandle,
    request_id: *const c_char,
    success: bool,
    session_id: *const c_char,
    encoded_dir_name: *const c_char,
    transcript_path: *const c_char,
    error: *const c_char,
) -> SocketClientError {
    if handle.is_null() || request_id.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let req_id = CStr::from_ptr(request_id)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        let sid = if session_id.is_null() {
            None
        } else {
            Some(CStr::from_ptr(session_id)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?)
        };

        let encoded = if encoded_dir_name.is_null() {
            None
        } else {
            Some(CStr::from_ptr(encoded_dir_name)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?)
        };

        let transcript = if transcript_path.is_null() {
            None
        } else {
            Some(CStr::from_ptr(transcript_path)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?)
        };

        let err = if error.is_null() {
            None
        } else {
            Some(CStr::from_ptr(error)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?)
        };

        handle.runtime.block_on(async {
            handle.client.send_session_created_result(req_id, success, sid, encoded, transcript, err).await
        }).map_err(|_| SocketClientError::EmitFailed)
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

/// 发送加载状态检查结果
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `request_id` 必须是有效字符串
#[no_mangle]
pub unsafe extern "C" fn socket_client_send_check_loading_result(
    handle: *mut SocketClientHandle,
    request_id: *const c_char,
    loading: bool,
) -> SocketClientError {
    if handle.is_null() || request_id.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let req_id = CStr::from_ptr(request_id)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        handle.runtime.block_on(async {
            handle.client.send_check_loading_result(req_id, loading).await
        }).map_err(|_| SocketClientError::EmitFailed)
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

/// 发送消息发送结果
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `request_id` 必须是有效字符串
/// - `message` 和 `via` 可为 null
#[no_mangle]
pub unsafe extern "C" fn socket_client_send_message_result(
    handle: *mut SocketClientHandle,
    request_id: *const c_char,
    success: bool,
    message: *const c_char,
    via: *const c_char,
) -> SocketClientError {
    if handle.is_null() || request_id.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let req_id = CStr::from_ptr(request_id)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        let msg = if message.is_null() {
            None
        } else {
            Some(CStr::from_ptr(message)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?)
        };

        let v = if via.is_null() {
            None
        } else {
            Some(CStr::from_ptr(via)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?)
        };

        handle.runtime.block_on(async {
            handle.client.send_message_result(req_id, success, msg, v).await
        }).map_err(|_| SocketClientError::EmitFailed)
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

// ==================== 版本信息 ====================

/// 获取版本号
///
/// # Safety
/// 返回静态字符串，无需释放
#[no_mangle]
pub extern "C" fn socket_client_version() -> *const c_char {
    static VERSION: &[u8] = concat!(env!("CARGO_PKG_VERSION"), "\0").as_bytes();
    VERSION.as_ptr() as *const c_char
}

// ==================== 辅助函数 ====================

/// 释放 C 字符串
///
/// # Safety
/// - `s` 必须是由本库创建的 C 字符串
#[no_mangle]
pub unsafe extern "C" fn socket_client_free_string(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

// ==================== Redis 服务发现 ====================

/// 创建带 Redis 配置的 Socket 客户端
///
/// # Safety
/// - `url` 必须是有效的 UTF-8 C 字符串
/// - `namespace` 可为 null
/// - `redis_host` 可为 null（不启用 Redis）
/// - `device_id`, `device_name`, `platform`, `version` 启用 Redis 时必填
/// - 返回的句柄需要通过 `socket_client_destroy` 释放
#[no_mangle]
pub unsafe extern "C" fn socket_client_create_with_redis(
    url: *const c_char,
    namespace: *const c_char,
    redis_host: *const c_char,
    redis_port: u16,
    redis_password: *const c_char,
    device_id: *const c_char,
    device_name: *const c_char,
    platform: *const c_char,
    version: *const c_char,
    ttl: u64,
    out_handle: *mut *mut SocketClientHandle,
) -> SocketClientError {
    if url.is_null() || out_handle.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let url_str = CStr::from_ptr(url)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        let namespace_str = if namespace.is_null() {
            "/daemon".to_string()
        } else {
            CStr::from_ptr(namespace)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?
                .to_string()
        };

        // TLS 配置
        let tls = TlsConfig {
            danger_accept_invalid_certs: true,
            ..Default::default()
        };

        // Redis 配置（可选）
        let redis_config = if !redis_host.is_null() {
            let host = CStr::from_ptr(redis_host)
                .to_str()
                .map_err(|_| SocketClientError::InvalidUtf8)?
                .to_string();

            let password = if redis_password.is_null() {
                None
            } else {
                Some(
                    CStr::from_ptr(redis_password)
                        .to_str()
                        .map_err(|_| SocketClientError::InvalidUtf8)?
                        .to_string(),
                )
            };

            Some(ServiceRegistryConfig {
                host,
                port: redis_port,
                password,
                key_prefix: "vlaude:".to_string(),
            })
        } else {
            None
        };

        // Daemon 信息（Redis 启用时必填）
        let daemon_info = if redis_config.is_some() {
            if device_id.is_null()
                || device_name.is_null()
                || platform.is_null()
                || version.is_null()
            {
                return Err(SocketClientError::NullPointer);
            }

            Some(DaemonRegistration {
                device_id: CStr::from_ptr(device_id)
                    .to_str()
                    .map_err(|_| SocketClientError::InvalidUtf8)?
                    .to_string(),
                device_name: CStr::from_ptr(device_name)
                    .to_str()
                    .map_err(|_| SocketClientError::InvalidUtf8)?
                    .to_string(),
                platform: CStr::from_ptr(platform)
                    .to_str()
                    .map_err(|_| SocketClientError::InvalidUtf8)?
                    .to_string(),
                version: CStr::from_ptr(version)
                    .to_str()
                    .map_err(|_| SocketClientError::InvalidUtf8)?
                    .to_string(),
                ttl,
            })
        } else {
            None
        };

        let config = SocketConfig {
            url: url_str.to_string(),
            namespace: namespace_str,
            tls,
            redis: redis_config,
            daemon_info,
        };

        let runtime = Runtime::new().map_err(|_| SocketClientError::RuntimeError)?;
        let client = SocketClient::new(config);

        Ok(SocketClientHandle {
            client: Arc::new(client),
            runtime: Arc::new(runtime),
            event_callback: Arc::new(RwLock::new(None)),
        })
    }));

    match result {
        Ok(Ok(handle)) => {
            *out_handle = Box::into_raw(Box::new(handle));
            SocketClientError::Success
        }
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}

/// 使用 Redis 服务发现连接
///
/// 1. 初始化 Redis 连接
/// 2. 从 Redis 发现 Server 地址
/// 3. 连接 Socket
/// 4. 注册到 Redis
/// 5. 启动心跳
///
/// # Safety
/// - `handle` 必须是有效句柄
#[no_mangle]
pub unsafe extern "C" fn socket_client_connect_with_discovery(
    handle: *mut SocketClientHandle,
) -> SocketClientError {
    if handle.is_null() {
        return SocketClientError::NullPointer;
    }

    let handle = &*handle;
    let result = handle
        .runtime
        .block_on(async { handle.client.connect_with_discovery().await });

    match result {
        Ok(_) => {
            // 启动事件接收循环
            start_event_loop(handle);
            SocketClientError::Success
        }
        Err(e) => {
            if e.to_string().contains("Registry") {
                SocketClientError::RegistryError
            } else {
                SocketClientError::ConnectionFailed
            }
        }
    }
}

/// 发现 Server 地址
///
/// 返回发现的第一个 Server 地址，如果没有则返回 null
/// 调用者需要使用 `socket_client_free_string` 释放返回的字符串
///
/// # Safety
/// - `handle` 必须是有效句柄
#[no_mangle]
pub unsafe extern "C" fn socket_client_discover_server(
    handle: *mut SocketClientHandle,
) -> *mut c_char {
    if handle.is_null() {
        return std::ptr::null_mut();
    }

    let handle = &*handle;
    let result = handle
        .runtime
        .block_on(async { handle.client.discover_server().await });

    match result {
        Ok(Some(addr)) => CString::new(addr).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut()),
        _ => std::ptr::null_mut(),
    }
}

/// 更新 Redis 中的 Session 列表
///
/// # Safety
/// - `handle` 必须是有效句柄
/// - `sessions_json` 必须是有效的 JSON 数组字符串，格式：
///   `[{"sessionId": "xxx", "projectPath": "/path"}]`
#[no_mangle]
pub unsafe extern "C" fn socket_client_update_sessions(
    handle: *mut SocketClientHandle,
    sessions_json: *const c_char,
) -> SocketClientError {
    if handle.is_null() || sessions_json.is_null() {
        return SocketClientError::NullPointer;
    }

    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let handle = &*handle;
        let sessions_str = CStr::from_ptr(sessions_json)
            .to_str()
            .map_err(|_| SocketClientError::InvalidUtf8)?;

        // 解析 JSON
        let sessions: Vec<SessionInfo> =
            serde_json::from_str(sessions_str).map_err(|_| SocketClientError::InvalidUtf8)?;

        handle
            .runtime
            .block_on(async { handle.client.update_sessions_in_redis(sessions).await })
            .map_err(|_| SocketClientError::RegistryError)
    }));

    match result {
        Ok(Ok(_)) => SocketClientError::Success,
        Ok(Err(e)) => e,
        Err(_) => SocketClientError::Unknown,
    }
}
