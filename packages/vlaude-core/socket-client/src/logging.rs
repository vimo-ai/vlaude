//! 日志桥接模块
//!
//! 将 Rust 端的日志转发到 Swift 端（LogManager）
//! FFI 层设置回调后，daemon-logic 可以通过此模块发送日志

use std::ffi::{c_char, CString};
use std::sync::atomic::{AtomicPtr, Ordering};

/// 日志级别（与 Swift LogLevel 对应）
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VlaudeLogLevel {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

/// 日志回调函数类型
pub type VlaudeLogCallback = extern "C" fn(level: VlaudeLogLevel, message: *const c_char);

/// 全局日志回调（原子指针，线程安全）
static VLAUDE_LOG_CALLBACK: AtomicPtr<()> = AtomicPtr::new(std::ptr::null_mut());

/// 设置日志回调（由 FFI 层调用）
pub fn set_log_callback(callback: VlaudeLogCallback) {
    VLAUDE_LOG_CALLBACK.store(callback as *mut (), Ordering::SeqCst);
}

/// 清除日志回调
pub fn clear_log_callback() {
    VLAUDE_LOG_CALLBACK.store(std::ptr::null_mut(), Ordering::SeqCst);
}

/// 发送日志消息
pub fn log_message(level: VlaudeLogLevel, message: &str) {
    let callback = VLAUDE_LOG_CALLBACK.load(Ordering::SeqCst);

    if !callback.is_null() {
        if let Ok(c_string) = CString::new(message) {
            let callback: VlaudeLogCallback = unsafe { std::mem::transmute(callback) };
            callback(level, c_string.as_ptr());
        } else {
            eprintln!("{}", message);
        }
    } else {
        eprintln!("{}", message);
    }
}

/// Info 日志宏
#[macro_export]
macro_rules! vlaude_log_info {
    ($($arg:tt)*) => {
        $crate::logging::log_message(
            $crate::logging::VlaudeLogLevel::Info,
            &format!($($arg)*)
        )
    };
}

/// Warn 日志宏
#[macro_export]
macro_rules! vlaude_log_warn {
    ($($arg:tt)*) => {
        $crate::logging::log_message(
            $crate::logging::VlaudeLogLevel::Warn,
            &format!($($arg)*)
        )
    };
}

/// Error 日志宏
#[macro_export]
macro_rules! vlaude_log_error {
    ($($arg:tt)*) => {
        $crate::logging::log_message(
            $crate::logging::VlaudeLogLevel::Error,
            &format!($($arg)*)
        )
    };
}
