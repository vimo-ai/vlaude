//! 会话文件监听器
//!
//! 监听会话文件变化并增量解析新消息

use anyhow::Result;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

/// 监听事件
#[derive(Debug, Clone)]
pub enum SessionWatchEvent {
    /// 新消息
    NewMessage {
        session_id: String,
        project_path: String,
        message: serde_json::Value,
    },
    /// 会话文件创建
    SessionCreated {
        session_id: String,
        project_path: String,
    },
    /// 会话文件删除
    SessionDeleted {
        session_id: String,
        project_path: String,
    },
    /// 错误
    Error {
        session_id: String,
        error: String,
    },
}

/// 会话状态
struct SessionState {
    path: PathBuf,
    project_path: String,
    last_position: u64,
}

/// 会话监听器
pub struct SessionWatcher {
    /// 被监听的会话状态
    sessions: Arc<RwLock<HashMap<String, SessionState>>>,
}

impl SessionWatcher {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 添加会话监听
    pub async fn watch_session(
        &self,
        session_id: &str,
        session_path: &Path,
        project_path: &str,
    ) -> Result<()> {
        info!("Start watching session: {} at {:?}", session_id, session_path);

        let position = if session_path.exists() {
            let metadata = std::fs::metadata(session_path)?;
            metadata.len()
        } else {
            0
        };

        let state = SessionState {
            path: session_path.to_path_buf(),
            project_path: project_path.to_string(),
            last_position: position,
        };

        self.sessions
            .write()
            .await
            .insert(session_id.to_string(), state);

        Ok(())
    }

    /// 停止会话监听
    pub async fn unwatch_session(&self, session_id: &str) {
        info!("Stop watching session: {}", session_id);
        self.sessions.write().await.remove(session_id);
    }

    /// 检查会话文件变化并读取增量
    pub async fn check_updates(&self) -> Result<Vec<SessionWatchEvent>> {
        let mut events = Vec::new();
        let mut deleted_sessions = Vec::new();

        // 收集需要检查的会话信息，缩小锁范围
        let session_snapshots: Vec<_> = {
            let sessions = self.sessions.read().await;
            sessions
                .iter()
                .map(|(id, state)| {
                    (
                        id.clone(),
                        state.path.clone(),
                        state.project_path.clone(),
                        state.last_position,
                    )
                })
                .collect()
        };

        // 在锁外执行 I/O 操作
        for (session_id, path, project_path, last_position) in session_snapshots {
            if !path.exists() {
                events.push(SessionWatchEvent::SessionDeleted {
                    session_id: session_id.clone(),
                    project_path,
                });
                deleted_sessions.push(session_id);
                continue;
            }

            match Self::read_incremental_static(&path, last_position) {
                Ok((new_messages, new_position)) => {
                    // 更新位置
                    if new_position > last_position {
                        let mut sessions = self.sessions.write().await;
                        if let Some(state) = sessions.get_mut(&session_id) {
                            state.last_position = new_position;
                        }
                    }

                    for msg in new_messages {
                        events.push(SessionWatchEvent::NewMessage {
                            session_id: session_id.clone(),
                            project_path: project_path.clone(),
                            message: msg,
                        });
                    }
                }
                Err(e) => {
                    events.push(SessionWatchEvent::Error {
                        session_id: session_id.clone(),
                        error: e.to_string(),
                    });
                }
            }
        }

        // 移除已删除的会话
        if !deleted_sessions.is_empty() {
            let mut sessions = self.sessions.write().await;
            for session_id in deleted_sessions {
                sessions.remove(&session_id);
            }
        }

        Ok(events)
    }

    /// 读取增量内容（静态方法，不需要锁）
    fn read_incremental_static(
        path: &Path,
        last_position: u64,
    ) -> Result<(Vec<serde_json::Value>, u64)> {
        let file = File::open(path)?;
        let metadata = file.metadata()?;
        let current_size = metadata.len();

        if current_size <= last_position {
            return Ok((Vec::new(), last_position));
        }

        let mut file = file;
        file.seek(SeekFrom::Start(last_position))?;

        let reader = BufReader::new(file);
        let mut messages = Vec::new();
        let mut new_position = last_position;

        for line in reader.lines() {
            match line {
                Ok(content) => {
                    new_position += content.len() as u64 + 1; // +1 for newline
                    if content.trim().is_empty() {
                        continue;
                    }
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        messages.push(json);
                    }
                }
                Err(e) => {
                    warn!("Failed to read line: {:?}", e);
                    break;
                }
            }
        }

        Ok((messages, new_position))
    }

    /// 是否有被监听的会话
    pub async fn has_sessions(&self) -> bool {
        !self.sessions.read().await.is_empty()
    }

    /// 获取监听的会话数
    pub async fn session_count(&self) -> usize {
        self.sessions.read().await.len()
    }
}

impl Default for SessionWatcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn test_session_watcher_basic() {
        let watcher = SessionWatcher::new();
        assert_eq!(watcher.session_count().await, 0);
        assert!(!watcher.has_sessions().await);
    }

    #[tokio::test]
    async fn test_watch_and_unwatch() {
        let watcher = SessionWatcher::new();

        let mut temp_file = NamedTempFile::new().unwrap();
        writeln!(temp_file, r#"{{"type":"user","message":"hello"}}"#).unwrap();
        temp_file.flush().unwrap();

        watcher
            .watch_session("test-session", temp_file.path(), "/test/project")
            .await
            .unwrap();

        assert_eq!(watcher.session_count().await, 1);

        watcher.unwatch_session("test-session").await;
        assert_eq!(watcher.session_count().await, 0);
    }

    #[tokio::test]
    async fn test_incremental_read() {
        let watcher = SessionWatcher::new();

        let mut temp_file = NamedTempFile::new().unwrap();
        writeln!(temp_file, r#"{{"type":"user","message":"hello"}}"#).unwrap();
        temp_file.flush().unwrap();

        watcher
            .watch_session("test-session", temp_file.path(), "/test/project")
            .await
            .unwrap();

        // First check - should be empty since we recorded initial position
        let events = watcher.check_updates().await.unwrap();
        assert!(events.is_empty());

        // Add new content
        writeln!(temp_file, r#"{{"type":"assistant","message":"world"}}"#).unwrap();
        temp_file.flush().unwrap();

        // Second check - should have the new message
        let events = watcher.check_updates().await.unwrap();
        assert_eq!(events.len(), 1);

        if let SessionWatchEvent::NewMessage { message, .. } = &events[0] {
            assert_eq!(message["type"], "assistant");
        } else {
            panic!("Expected NewMessage event");
        }
    }
}
