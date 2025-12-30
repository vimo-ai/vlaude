//! 文件监听模块
//!
//! 监听 Claude projects 目录的变化

use anyhow::Result;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebouncedEvent, Debouncer};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

/// 监听模式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchMode {
    /// 监听项目列表变化（目录级别）
    Projects,
    /// 监听指定项目的会话列表变化
    Sessions,
    /// 监听指定会话文件的内容变化
    SessionContent,
}

/// 监听事件
#[derive(Debug, Clone)]
pub enum WatchEvent {
    /// 文件创建
    Created(PathBuf),
    /// 文件修改
    Modified(PathBuf),
    /// 文件删除
    Removed(PathBuf),
    /// 错误
    Error(String),
}

/// 文件监听器
pub struct FileWatcher {
    debouncer: Debouncer<RecommendedWatcher>,
    rx: Receiver<Result<Vec<DebouncedEvent>, notify::Error>>,
}

impl FileWatcher {
    /// 创建监听器
    pub fn new(path: &Path, mode: WatchMode) -> Result<Self> {
        let (tx, rx) = channel();

        let debounce_time = match mode {
            WatchMode::Projects => Duration::from_millis(500),
            WatchMode::Sessions => Duration::from_millis(300),
            WatchMode::SessionContent => Duration::from_millis(100),
        };

        let mut debouncer = new_debouncer(debounce_time, tx)?;

        let recursive_mode = match mode {
            WatchMode::Projects => RecursiveMode::NonRecursive,
            WatchMode::Sessions => RecursiveMode::NonRecursive,
            WatchMode::SessionContent => RecursiveMode::NonRecursive,
        };

        debouncer.watcher().watch(path, recursive_mode)?;

        Ok(Self { debouncer, rx })
    }

    /// 获取下一个事件（阻塞）
    pub fn next_event(&self) -> Option<Vec<WatchEvent>> {
        match self.rx.recv() {
            Ok(Ok(events)) => Some(self.convert_events(events)),
            Ok(Err(e)) => Some(vec![WatchEvent::Error(e.to_string())]),
            Err(_) => None,
        }
    }

    /// 尝试获取事件（非阻塞）
    pub fn try_next_event(&self) -> Option<Vec<WatchEvent>> {
        match self.rx.try_recv() {
            Ok(Ok(events)) => Some(self.convert_events(events)),
            Ok(Err(e)) => Some(vec![WatchEvent::Error(e.to_string())]),
            Err(_) => None,
        }
    }

    /// 添加监听路径
    pub fn watch(&mut self, path: &Path, recursive: bool) -> Result<()> {
        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        self.debouncer.watcher().watch(path, mode)?;
        Ok(())
    }

    /// 移除监听路径
    pub fn unwatch(&mut self, path: &Path) -> Result<()> {
        self.debouncer.watcher().unwatch(path)?;
        Ok(())
    }

    fn convert_events(&self, events: Vec<DebouncedEvent>) -> Vec<WatchEvent> {
        events
            .into_iter()
            .map(|e| WatchEvent::Modified(e.path))
            .collect()
    }
}

/// 创建异步事件流的 helper
pub fn watch_with_callback<F>(path: &Path, mode: WatchMode, _callback: F) -> Result<FileWatcher>
where
    F: FnMut(WatchEvent) + Send + 'static,
{
    let watcher = FileWatcher::new(path, mode)?;

    // 注意：这里返回 watcher，调用者需要在自己的循环中处理事件
    // 或者使用 tokio spawn 来处理

    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_watch_mode() {
        assert_eq!(WatchMode::Projects, WatchMode::Projects);
        assert_ne!(WatchMode::Projects, WatchMode::Sessions);
    }
}
