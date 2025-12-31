//! Claude Code 数据读取器
//!
//! 基于 claude-session-db 的 ClaudeAdapter 实现（re-export from ai-cli-session-collector）
//! 解析 ~/.claude/projects/{encoded-path}/{session-uuid}.jsonl

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use claude_session_db::{ClaudeAdapter, ConversationAdapter, MessageType};

use crate::types::*;

/// Claude Code 数据读取器
pub struct ClaudeReader {
    /// Claude projects 目录路径
    projects_path: PathBuf,
    /// 路径缓存: projectPath -> encodedDirName
    path_cache: HashMap<String, String>,
    /// 内部 adapter
    adapter: ClaudeAdapter,
}

impl ClaudeReader {
    /// 创建读取器
    pub fn new(projects_path: PathBuf) -> Self {
        let adapter = ClaudeAdapter::new(projects_path.clone());
        Self {
            projects_path,
            path_cache: HashMap::new(),
            adapter,
        }
    }

    /// 使用默认路径创建读取器
    pub fn default() -> Result<Self> {
        let home = std::env::var("HOME").context("无法获取 HOME 环境变量")?;
        let projects_path = PathBuf::from(home).join(".claude/projects");
        Ok(Self::new(projects_path))
    }

    /// 解码 Claude Code 目录名为真实路径
    /// 委托给 ClaudeAdapter
    pub fn decode_path(encoded: &str) -> String {
        ClaudeAdapter::decode_path(encoded)
    }

    /// 编码项目路径为 Claude 目录名
    /// @example /Users/xxx/project → -Users-xxx-project
    pub fn encode_path(path: &str) -> String {
        if path.starts_with('/') {
            format!("-{}", &path[1..].replace('/', "-"))
        } else {
            path.replace('/', "-")
        }
    }

    /// 从路径提取项目名
    pub fn extract_project_name(path: &str) -> String {
        ClaudeAdapter::extract_project_name(path)
    }

    /// 列出所有项目
    pub fn list_projects(&mut self, limit: Option<usize>) -> Result<Vec<ProjectInfo>> {
        let mut results = Vec::new();

        if !self.projects_path.exists() {
            tracing::warn!("Claude projects 目录不存在: {:?}", self.projects_path);
            return Ok(results);
        }

        for entry in fs::read_dir(&self.projects_path)? {
            let entry = entry?;
            let project_dir = entry.path();

            if !project_dir.is_dir() {
                continue;
            }

            let encoded_name = project_dir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default();

            if encoded_name.is_empty() || encoded_name.starts_with('.') {
                continue;
            }

            let decoded_path = Self::decode_path(encoded_name);
            let project_name = Self::extract_project_name(&decoded_path);

            // 更新缓存
            self.path_cache
                .insert(decoded_path.clone(), encoded_name.to_string());

            // 统计会话数量和最后活跃时间
            let mut session_count = 0;
            let mut last_active: Option<u64> = None;

            if let Ok(files) = fs::read_dir(&project_dir) {
                for file_entry in files.flatten() {
                    let file_path = file_entry.path();
                    if file_path.is_file()
                        && file_path
                            .extension()
                            .map(|e| e == "jsonl")
                            .unwrap_or(false)
                    {
                        session_count += 1;

                        if let Ok(meta) = fs::metadata(&file_path) {
                            if let Ok(mtime) = meta.modified() {
                                let ts = mtime
                                    .duration_since(UNIX_EPOCH)
                                    .map(|d| d.as_millis() as u64)
                                    .unwrap_or(0);
                                last_active = Some(last_active.map(|t| t.max(ts)).unwrap_or(ts));
                            }
                        }
                    }
                }
            }

            results.push(ProjectInfo {
                encoded_name: encoded_name.to_string(),
                path: decoded_path,
                name: project_name,
                session_count,
                last_active,
            });
        }

        // 按最后活跃时间排序（降序）
        results.sort_by(|a, b| b.last_active.cmp(&a.last_active));

        // 应用 limit
        if let Some(limit) = limit {
            results.truncate(limit);
        }

        Ok(results)
    }

    /// 列出项目下的所有会话
    /// 委托给 ClaudeAdapter，可选按项目路径过滤
    pub fn list_sessions(&mut self, project_path: Option<&str>) -> Result<Vec<SessionMeta>> {
        // 使用 ClaudeAdapter 获取所有会话
        let mut sessions = self.adapter.list_sessions()?;

        // 更新 path_cache
        for session in &sessions {
            if let Some(encoded) = &session.encoded_dir_name {
                self.path_cache
                    .insert(session.project_path.clone(), encoded.clone());
            }
        }

        // 按项目路径过滤
        if let Some(path) = project_path {
            sessions.retain(|s| s.project_path == path);
        }

        // 按修改时间排序（降序）
        sessions.sort_by(|a, b| b.file_mtime.cmp(&a.file_mtime));

        Ok(sessions)
    }

    /// 查找最新会话
    pub fn find_latest_session(
        &mut self,
        project_path: &str,
        within_seconds: Option<u64>,
    ) -> Result<Option<SessionMeta>> {
        let sessions = self.list_sessions(Some(project_path))?;

        if sessions.is_empty() {
            return Ok(None);
        }

        let latest = sessions.into_iter().next();

        // 如果指定了时间范围，检查会话是否在范围内
        if let (Some(session), Some(within_secs)) = (&latest, within_seconds) {
            if let Some(mtime) = session.file_mtime {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let diff_ms = now.saturating_sub(mtime);
                if diff_ms > within_secs * 1000 {
                    return Ok(None);
                }
            }
        }

        Ok(latest)
    }

    /// 读取会话消息（支持分页）
    pub fn read_messages(
        &self,
        session_path: &str,
        limit: usize,
        offset: usize,
        order: Order,
    ) -> Result<MessagesResult> {
        // 构造一个临时 SessionMeta 来调用 parse_session
        let session_id = std::path::Path::new(session_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        let meta = SessionMeta {
            id: session_id,
            source: Source::Claude,
            channel: Some("code".to_string()),
            project_path: String::new(),
            project_name: None,
            encoded_dir_name: None,
            session_path: Some(session_path.to_string()),
            file_mtime: None,
            file_size: None,
            cwd: None,
            model: None,
            meta: None,
            created_at: None,
            updated_at: None,
        };

        let result = self.adapter.parse_session(&meta)?;

        let Some(result) = result else {
            return Ok(MessagesResult {
                messages: vec![],
                total: 0,
                has_more: false,
            });
        };

        let mut all_messages = result.messages;
        let total = all_messages.len();

        // 排序
        if order == Order::Desc {
            all_messages.reverse();
        }

        // 分页
        let start = offset.min(total);
        let end = (offset + limit).min(total);
        let messages: Vec<_> = all_messages[start..end].to_vec();
        let has_more = end < total;

        Ok(MessagesResult {
            messages,
            total,
            has_more,
        })
    }

    /// 读取原始 JSONL 消息（不做格式转换，直接返回原始 JSON）
    pub fn read_messages_raw(
        &self,
        session_path: &str,
        limit: usize,
        offset: usize,
        order: Order,
    ) -> Result<RawMessagesResult> {
        use std::io::{BufRead, BufReader};

        let file = fs::File::open(session_path)
            .with_context(|| format!("Failed to open session file: {}", session_path))?;
        let reader = BufReader::new(file);

        // 读取所有行并解析为 JSON
        let mut all_messages: Vec<serde_json::Value> = Vec::new();
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                all_messages.push(json);
            }
        }

        let total = all_messages.len();

        // 排序
        if order == Order::Desc {
            all_messages.reverse();
        }

        // 分页
        let start = offset.min(total);
        let end = (offset + limit).min(total);
        let messages: Vec<_> = all_messages[start..end].to_vec();
        let has_more = end < total;

        Ok(RawMessagesResult {
            messages,
            total,
            has_more,
        })
    }

    /// 解析完整会话
    /// 委托给 ClaudeAdapter
    pub fn parse_session(&self, meta: &SessionMeta) -> Result<Option<ParseResult>> {
        self.adapter.parse_session(meta)
    }

    /// 计算会话 Metrics
    pub fn calculate_metrics(&self, meta: &SessionMeta) -> Result<Option<SessionMetrics>> {
        let result = self.parse_session(meta)?;

        let Some(result) = result else {
            return Ok(None);
        };

        let user_count = result
            .messages
            .iter()
            .filter(|m| m.message_type == MessageType::User)
            .count();
        let assistant_count = result
            .messages
            .iter()
            .filter(|m| m.message_type == MessageType::Assistant)
            .count();

        // 估算 token 数（简单按字符数 / 4）
        let total_chars: usize = result.messages.iter().map(|m| m.content.len()).sum();
        let estimated_tokens = total_chars / 4;

        // 计算时长
        let duration = if let (Some(first), Some(last)) = (&result.created_at, &result.updated_at) {
            // 尝试解析 ISO8601 时间戳
            if let (Ok(first_dt), Ok(last_dt)) = (
                chrono::DateTime::parse_from_rfc3339(first),
                chrono::DateTime::parse_from_rfc3339(last),
            ) {
                Some((last_dt - first_dt).num_seconds().max(0) as u64)
            } else {
                None
            }
        } else {
            None
        };

        Ok(Some(SessionMetrics {
            message_count: result.messages.len(),
            user_message_count: user_count,
            assistant_message_count: assistant_count,
            estimated_tokens,
            duration_seconds: duration,
        }))
    }

    /// 获取编码后的目录名
    pub fn get_encoded_dir_name(&self, project_path: &str) -> Option<String> {
        self.path_cache.get(project_path).cloned()
    }

    /// 从 JSONL 文件路径解析会话，用于索引到 SharedDb
    ///
    /// 直接委托给 ClaudeAdapter::parse_session_from_path
    /// 会正确读取 cwd 来确定真实的项目路径，避免中文路径解析错误
    ///
    /// # 参数
    /// - `jsonl_path`: JSONL 文件完整路径
    ///
    /// # 返回
    /// - `Ok(Some(IndexableSession))`: 解析成功
    /// - `Ok(None)`: 文件为空或无有效消息
    /// - `Err`: 解析失败
    pub fn parse_session_from_path(&self, jsonl_path: &str) -> Result<Option<IndexableSession>> {
        // 直接调用 ai-cli-session-collector 的核心实现
        ClaudeAdapter::parse_session_from_path(jsonl_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_path() {
        assert_eq!(
            ClaudeReader::decode_path("-Users-xxx-project"),
            "/Users/xxx/project"
        );
        assert_eq!(ClaudeReader::decode_path("foo-bar"), "foo/bar");
    }

    #[test]
    fn test_encode_path() {
        assert_eq!(
            ClaudeReader::encode_path("/Users/xxx/project"),
            "-Users-xxx-project"
        );
        assert_eq!(ClaudeReader::encode_path("foo/bar"), "foo-bar");
    }

    #[test]
    fn test_extract_project_name() {
        assert_eq!(
            ClaudeReader::extract_project_name("/Users/xxx/project"),
            "project"
        );
        assert_eq!(ClaudeReader::extract_project_name("/a/b/c/d"), "d");
    }
}
