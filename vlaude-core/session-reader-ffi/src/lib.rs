//! Session Reader FFI - 轻量级 C ABI 导出层
//!
//! 为 VlaudeKit (Swift) 提供 Claude 会话文件读取能力。
//! 不包含 Socket 连接，Socket 由 ETermKit 的 SocketService 处理。
//!
//! 设计原则：
//! - 返回 JSON 字符串，Swift 端用 Codable 解析
//! - 错误返回 null
//! - 调用者负责释放返回的字符串

use session_reader::{ClaudeReader, Order};
use std::ffi::{c_char, CStr, CString};
use std::ptr;
use std::sync::Mutex;

/// Session Reader 句柄
pub struct SRReader {
    inner: Mutex<ClaudeReader>,
}

// ==================== 生命周期管理 ====================

/// 创建 Reader 实例
///
/// # 返回
/// - 成功：返回 Reader 指针
/// - 失败：返回 null
///
/// # Safety
/// 调用者负责通过 `sr_destroy` 释放返回的指针
#[no_mangle]
pub extern "C" fn sr_create() -> *mut SRReader {
    match ClaudeReader::default() {
        Ok(reader) => {
            let handle = Box::new(SRReader {
                inner: Mutex::new(reader),
            });
            Box::into_raw(handle)
        }
        Err(e) => {
            tracing::error!("Failed to create ClaudeReader: {:?}", e);
            ptr::null_mut()
        }
    }
}

/// 使用自定义路径创建 Reader 实例
///
/// # 参数
/// - `projects_path`: Claude projects 目录路径（如 ~/.claude/projects）
///
/// # Safety
/// - `projects_path` 必须是有效的 UTF-8 C 字符串
/// - 调用者负责通过 `sr_destroy` 释放返回的指针
#[no_mangle]
pub unsafe extern "C" fn sr_create_with_path(projects_path: *const c_char) -> *mut SRReader {
    if projects_path.is_null() {
        return sr_create();
    }

    let path = match CStr::from_ptr(projects_path).to_str() {
        Ok(s) => s,
        Err(_) => return ptr::null_mut(),
    };

    let reader = ClaudeReader::new(path.into());
    let handle = Box::new(SRReader {
        inner: Mutex::new(reader),
    });
    Box::into_raw(handle)
}

/// 释放 Reader 实例
///
/// # Safety
/// - `reader` 必须是 `sr_create` 或 `sr_create_with_path` 返回的有效指针
/// - 只能调用一次
#[no_mangle]
pub unsafe extern "C" fn sr_destroy(reader: *mut SRReader) {
    if !reader.is_null() {
        let _ = Box::from_raw(reader);
    }
}

// ==================== 项目操作 ====================

/// 列出所有项目
///
/// # 参数
/// - `reader`: Reader 指针
/// - `limit`: 最大返回数量，0 表示不限制
///
/// # 返回
/// - 成功：返回 JSON 字符串（ProjectInfo 数组）
/// - 失败：返回 null
///
/// # Safety
/// - `reader` 必须是有效指针
/// - 调用者负责通过 `sr_free_string` 释放返回的字符串
#[no_mangle]
pub unsafe extern "C" fn sr_list_projects(
    reader: *mut SRReader,
    limit: u32,
) -> *mut c_char {
    if reader.is_null() {
        return ptr::null_mut();
    }

    let reader = &*reader;
    let limit_opt = if limit == 0 { None } else { Some(limit as usize) };

    let mut guard = match reader.inner.lock() {
        Ok(g) => g,
        Err(_) => return ptr::null_mut(),
    };

    match guard.list_projects(limit_opt) {
        Ok(projects) => json_to_cstring(&projects),
        Err(e) => {
            tracing::error!("Failed to list projects: {:?}", e);
            ptr::null_mut()
        }
    }
}

// ==================== 会话操作 ====================

/// 列出项目下的所有会话
///
/// # 参数
/// - `reader`: Reader 指针
/// - `project_path`: 项目路径（可选，null 表示列出所有项目的会话）
///
/// # 返回
/// - 成功：返回 JSON 字符串（SessionMeta 数组）
/// - 失败：返回 null
///
/// # Safety
/// - `reader` 必须是有效指针
/// - `project_path` 如果非 null，必须是有效的 UTF-8 C 字符串
/// - 调用者负责通过 `sr_free_string` 释放返回的字符串
#[no_mangle]
pub unsafe extern "C" fn sr_list_sessions(
    reader: *mut SRReader,
    project_path: *const c_char,
) -> *mut c_char {
    if reader.is_null() {
        return ptr::null_mut();
    }

    let reader = &*reader;
    let path_opt = if project_path.is_null() {
        None
    } else {
        match CStr::from_ptr(project_path).to_str() {
            Ok(s) => Some(s),
            Err(_) => return ptr::null_mut(),
        }
    };

    let mut guard = match reader.inner.lock() {
        Ok(g) => g,
        Err(_) => return ptr::null_mut(),
    };

    match guard.list_sessions(path_opt) {
        Ok(sessions) => json_to_cstring(&sessions),
        Err(e) => {
            tracing::error!("Failed to list sessions: {:?}", e);
            ptr::null_mut()
        }
    }
}

/// 查找最新会话
///
/// # 参数
/// - `reader`: Reader 指针
/// - `project_path`: 项目路径
/// - `within_seconds`: 时间范围（秒），0 表示不限制
///
/// # 返回
/// - 成功：返回 JSON 字符串（SessionMeta 或 null）
/// - 失败：返回 null
///
/// # Safety
/// - `reader` 必须是有效指针
/// - `project_path` 必须是有效的 UTF-8 C 字符串
/// - 调用者负责通过 `sr_free_string` 释放返回的字符串
#[no_mangle]
pub unsafe extern "C" fn sr_find_latest_session(
    reader: *mut SRReader,
    project_path: *const c_char,
    within_seconds: u64,
) -> *mut c_char {
    if reader.is_null() || project_path.is_null() {
        return ptr::null_mut();
    }

    let reader = &*reader;
    let path = match CStr::from_ptr(project_path).to_str() {
        Ok(s) => s,
        Err(_) => return ptr::null_mut(),
    };

    let within_opt = if within_seconds == 0 {
        None
    } else {
        Some(within_seconds)
    };

    let mut guard = match reader.inner.lock() {
        Ok(g) => g,
        Err(_) => return ptr::null_mut(),
    };

    match guard.find_latest_session(path, within_opt) {
        Ok(Some(session)) => json_to_cstring(&session),
        Ok(None) => json_to_cstring(&serde_json::Value::Null),
        Err(e) => {
            tracing::error!("Failed to find latest session: {:?}", e);
            ptr::null_mut()
        }
    }
}

// ==================== 消息操作 ====================

/// 读取会话消息
///
/// # 参数
/// - `reader`: Reader 指针
/// - `session_path`: 会话文件完整路径
/// - `limit`: 最大返回数量
/// - `offset`: 偏移量
/// - `order_asc`: true=升序, false=降序
///
/// # 返回
/// - 成功：返回 JSON 字符串（MessagesResult）
/// - 失败：返回 null
///
/// # Safety
/// - `reader` 必须是有效指针
/// - `session_path` 必须是有效的 UTF-8 C 字符串
/// - 调用者负责通过 `sr_free_string` 释放返回的字符串
#[no_mangle]
pub unsafe extern "C" fn sr_read_messages(
    reader: *mut SRReader,
    session_path: *const c_char,
    limit: u32,
    offset: u32,
    order_asc: bool,
) -> *mut c_char {
    if reader.is_null() || session_path.is_null() {
        return ptr::null_mut();
    }

    let reader = &*reader;
    let path = match CStr::from_ptr(session_path).to_str() {
        Ok(s) => s,
        Err(_) => return ptr::null_mut(),
    };

    let order = if order_asc { Order::Asc } else { Order::Desc };

    let guard = match reader.inner.lock() {
        Ok(g) => g,
        Err(_) => return ptr::null_mut(),
    };

    match guard.read_messages(path, limit as usize, offset as usize, order) {
        Ok(result) => json_to_cstring(&result),
        Err(e) => {
            tracing::error!("Failed to read messages: {:?}", e);
            ptr::null_mut()
        }
    }
}

// ==================== 路径工具 ====================

/// 编码项目路径为 Claude 目录名
///
/// # 参数
/// - `path`: 项目路径（如 /Users/xxx/project）
///
/// # 返回
/// - 返回编码后的目录名（如 -Users-xxx-project）
///
/// # Safety
/// - `path` 必须是有效的 UTF-8 C 字符串
/// - 调用者负责通过 `sr_free_string` 释放返回的字符串
#[no_mangle]
pub unsafe extern "C" fn sr_encode_path(path: *const c_char) -> *mut c_char {
    if path.is_null() {
        return ptr::null_mut();
    }

    let path = match CStr::from_ptr(path).to_str() {
        Ok(s) => s,
        Err(_) => return ptr::null_mut(),
    };

    let encoded = ClaudeReader::encode_path(path);
    string_to_cstring(&encoded)
}

/// 解码 Claude 目录名为项目路径
///
/// # 参数
/// - `encoded`: 编码后的目录名（如 -Users-xxx-project）
///
/// # 返回
/// - 返回解码后的路径（如 /Users/xxx/project）
///
/// # Safety
/// - `encoded` 必须是有效的 UTF-8 C 字符串
/// - 调用者负责通过 `sr_free_string` 释放返回的字符串
#[no_mangle]
pub unsafe extern "C" fn sr_decode_path(encoded: *const c_char) -> *mut c_char {
    if encoded.is_null() {
        return ptr::null_mut();
    }

    let encoded = match CStr::from_ptr(encoded).to_str() {
        Ok(s) => s,
        Err(_) => return ptr::null_mut(),
    };

    let decoded = ClaudeReader::decode_path(encoded);
    string_to_cstring(&decoded)
}

// ==================== 索引工具 ====================

/// 解析 JSONL 会话文件，用于索引到 SharedDb
///
/// 会正确读取 cwd 来确定真实的项目路径，避免中文路径解析错误
///
/// # 参数
/// - `reader`: Reader 指针
/// - `jsonl_path`: JSONL 文件完整路径
///
/// # 返回
/// - 成功：返回 JSON 字符串（IndexableSession）
/// - 文件为空或无有效消息：返回 "null"
/// - 失败：返回 null
///
/// # Safety
/// - `reader` 必须是有效指针
/// - `jsonl_path` 必须是有效的 UTF-8 C 字符串
/// - 调用者负责通过 `sr_free_string` 释放返回的字符串
#[no_mangle]
pub unsafe extern "C" fn sr_parse_session_for_index(
    reader: *mut SRReader,
    jsonl_path: *const c_char,
) -> *mut c_char {
    if reader.is_null() || jsonl_path.is_null() {
        return ptr::null_mut();
    }

    let reader = &*reader;
    let path = match CStr::from_ptr(jsonl_path).to_str() {
        Ok(s) => s,
        Err(_) => return ptr::null_mut(),
    };

    let guard = match reader.inner.lock() {
        Ok(g) => g,
        Err(_) => return ptr::null_mut(),
    };

    match guard.parse_session_from_path(path) {
        Ok(Some(session)) => json_to_cstring(&session),
        Ok(None) => json_to_cstring(&serde_json::Value::Null),
        Err(e) => {
            tracing::error!("Failed to parse session for index: {:?}", e);
            ptr::null_mut()
        }
    }
}

// ==================== 内存管理 ====================

/// 释放由本库返回的字符串
///
/// # Safety
/// - `s` 必须是本库函数返回的字符串指针
/// - 只能调用一次
#[no_mangle]
pub unsafe extern "C" fn sr_free_string(s: *mut c_char) {
    if !s.is_null() {
        let _ = CString::from_raw(s);
    }
}

// ==================== 版本信息 ====================

/// 获取库版本号
///
/// # 返回
/// - 返回静态版本字符串，不需要释放
#[no_mangle]
pub extern "C" fn sr_version() -> *const c_char {
    static VERSION: &[u8] = concat!(env!("CARGO_PKG_VERSION"), "\0").as_bytes();
    VERSION.as_ptr() as *const c_char
}

// ==================== 内部辅助函数 ====================

fn json_to_cstring<T: serde::Serialize>(value: &T) -> *mut c_char {
    match serde_json::to_string(value) {
        Ok(json) => string_to_cstring(&json),
        Err(_) => ptr::null_mut(),
    }
}

fn string_to_cstring(s: &str) -> *mut c_char {
    match CString::new(s) {
        Ok(cs) => cs.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode_path() {
        unsafe {
            let path = CString::new("/Users/test/project").unwrap();
            let encoded = sr_encode_path(path.as_ptr());
            assert!(!encoded.is_null());

            let decoded = sr_decode_path(encoded);
            assert!(!decoded.is_null());

            let result = CStr::from_ptr(decoded).to_str().unwrap();
            assert_eq!(result, "/Users/test/project");

            sr_free_string(encoded);
            sr_free_string(decoded);
        }
    }

    #[test]
    fn test_version() {
        let version = sr_version();
        assert!(!version.is_null());
        unsafe {
            let s = CStr::from_ptr(version).to_str().unwrap();
            assert!(!s.is_empty());
        }
    }
}
