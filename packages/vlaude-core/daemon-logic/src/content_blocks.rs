//! ContentBlocks 解析模块
//!
//! 从原始 JSONL 消息解析结构化内容块，用于 UI 渲染。
//! 这是 Swift ContentBlockParser 的 Rust 实现，作为共享模块供 daemon-rs 和 VlaudeKit 使用。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// 内容块类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// 纯文本
    Text { text: String },

    /// 工具调用
    #[serde(rename_all = "camelCase")]
    ToolUse {
        id: String,
        name: String,
        input: HashMap<String, Value>,
        /// UI 展示用的简短描述
        #[serde(skip_serializing_if = "Option::is_none")]
        display_text: Option<String>,
        /// 工具图标名称
        #[serde(skip_serializing_if = "Option::is_none")]
        icon_name: Option<String>,
    },

    /// 工具返回结果
    #[serde(rename_all = "camelCase")]
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        is_error: bool,
        content: String,
        /// 内容预览
        #[serde(skip_serializing_if = "Option::is_none")]
        preview: Option<String>,
        /// 是否有更多内容
        #[serde(skip_serializing_if = "Option::is_none")]
        has_more: Option<bool>,
        /// 内容大小描述
        #[serde(skip_serializing_if = "Option::is_none")]
        size_description: Option<String>,
    },

    /// 思考过程
    Thinking { thinking: String },

    /// 未知类型
    Unknown { raw: String },
}

/// 解析原始消息 JSON 为 contentBlocks
///
/// # 参数
/// - `raw_message`: 原始 JSONL 行解析出的 JSON 对象
///
/// # 返回
/// - 解析后的 ContentBlock 数组，失败返回空数组
pub fn parse_content_blocks(raw_message: &Value) -> Vec<ContentBlock> {
    // 尝试从 message.content 获取内容
    let content = raw_message
        .get("message")
        .and_then(|m| m.get("content"));

    let Some(content) = content else {
        return Vec::new();
    };

    // content 可能是字符串或数组
    if let Some(text) = content.as_str() {
        return vec![ContentBlock::Text {
            text: text.to_string(),
        }];
    }

    let Some(blocks) = content.as_array() else {
        return Vec::new();
    };

    blocks.iter().filter_map(parse_block).collect()
}

/// 解析单个内容块
fn parse_block(block: &Value) -> Option<ContentBlock> {
    let block_type = block.get("type")?.as_str()?;

    match block_type {
        "text" => {
            let text = block.get("text")?.as_str()?.to_string();
            Some(ContentBlock::Text { text })
        }

        "tool_use" => {
            let id = block.get("id")?.as_str()?.to_string();
            let name = block.get("name")?.as_str()?.to_string();
            let input = block
                .get("input")
                .and_then(|v| v.as_object())
                .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();

            let display_text = generate_tool_display_text(&name, &input);
            let icon_name = get_tool_icon(&name);

            Some(ContentBlock::ToolUse {
                id,
                name,
                input,
                display_text: Some(display_text),
                icon_name: Some(icon_name),
            })
        }

        "tool_result" => {
            let tool_use_id = block.get("tool_use_id")?.as_str()?.to_string();
            let is_error = block.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
            let content = extract_tool_result_content(block.get("content"));
            let preview = generate_preview(&content);
            let has_more = content.len() > 200;
            let size_description = generate_size_description(content.len());

            Some(ContentBlock::ToolResult {
                tool_use_id,
                is_error,
                content,
                preview: Some(preview),
                has_more: Some(has_more),
                size_description: Some(size_description),
            })
        }

        "thinking" => {
            let thinking = block.get("thinking")?.as_str()?.to_string();
            Some(ContentBlock::Thinking { thinking })
        }

        _ => {
            // 返回原始 JSON 作为 fallback
            let raw = serde_json::to_string(block).unwrap_or_default();
            Some(ContentBlock::Unknown { raw })
        }
    }
}

/// 生成工具调用的展示文本
fn generate_tool_display_text(name: &str, input: &HashMap<String, Value>) -> String {
    match name {
        "Read" => {
            if let Some(path) = input.get("file_path").and_then(|v| v.as_str()) {
                let file_name = std::path::Path::new(path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(path);
                if let Some(limit) = input.get("limit").and_then(|v| v.as_u64()) {
                    return format!("读取文件: {} (前 {} 行)", file_name, limit);
                }
                return format!("读取文件: {}", file_name);
            }
            "读取文件".to_string()
        }

        "Write" => {
            if let Some(path) = input.get("file_path").and_then(|v| v.as_str()) {
                let file_name = std::path::Path::new(path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(path);
                return format!("写入文件: {}", file_name);
            }
            "写入文件".to_string()
        }

        "Edit" => {
            if let Some(path) = input.get("file_path").and_then(|v| v.as_str()) {
                let file_name = std::path::Path::new(path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(path);
                return format!("编辑文件: {}", file_name);
            }
            "编辑文件".to_string()
        }

        "Bash" => {
            if let Some(cmd) = input.get("command").and_then(|v| v.as_str()) {
                let preview: String = cmd.chars().take(50).collect();
                let suffix = if cmd.len() > 50 { "..." } else { "" };
                return format!("执行命令: {}{}", preview, suffix);
            }
            "执行命令".to_string()
        }

        "Glob" => {
            if let Some(pattern) = input.get("pattern").and_then(|v| v.as_str()) {
                return format!("搜索文件: {}", pattern);
            }
            "搜索文件".to_string()
        }

        "Grep" => {
            if let Some(pattern) = input.get("pattern").and_then(|v| v.as_str()) {
                return format!("搜索内容: {}", pattern);
            }
            "搜索内容".to_string()
        }

        "Task" => {
            if let Some(desc) = input.get("description").and_then(|v| v.as_str()) {
                return format!("子任务: {}", desc);
            }
            "子任务".to_string()
        }

        "WebFetch" => {
            if let Some(url) = input.get("url").and_then(|v| v.as_str()) {
                return format!("获取网页: {}", url);
            }
            "获取网页".to_string()
        }

        "WebSearch" => {
            if let Some(query) = input.get("query").and_then(|v| v.as_str()) {
                return format!("搜索: {}", query);
            }
            "网络搜索".to_string()
        }

        _ => format!("工具: {}", name),
    }
}

/// 获取工具图标名称
fn get_tool_icon(name: &str) -> String {
    match name {
        "Read" => "doc.text",
        "Write" => "square.and.pencil",
        "Edit" => "pencil",
        "Bash" => "terminal",
        "Glob" => "folder.badge.questionmark",
        "Grep" => "magnifyingglass",
        "Task" => "list.bullet",
        "WebFetch" => "globe",
        "WebSearch" => "magnifyingglass.circle",
        "TodoWrite" => "checklist",
        _ => "wrench",
    }
    .to_string()
}

/// 提取 tool_result 的内容
fn extract_tool_result_content(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };

    if let Some(s) = content.as_str() {
        return s.to_string();
    }

    serde_json::to_string_pretty(content).unwrap_or_else(|_| format!("{}", content))
}

/// 生成内容预览（UTF-8 安全）
fn generate_preview(content: &str) -> String {
    const MAX_CHARS: usize = 200;
    let char_count = content.chars().count();
    if char_count <= MAX_CHARS {
        content.to_string()
    } else {
        let truncated: String = content.chars().take(MAX_CHARS).collect();
        format!("{}...", truncated)
    }
}

/// 生成内容大小描述
fn generate_size_description(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// 为消息添加 contentBlocks 字段
///
/// 如果消息有 raw 字段，解析它并添加 contentBlocks
pub fn enrich_message_with_content_blocks(message: &mut Value) {
    // 尝试获取 raw 字段
    let raw_str = message.get("raw").and_then(|v| v.as_str());

    let blocks = if let Some(raw_str) = raw_str {
        // 解析 raw JSON 字符串
        if let Ok(raw_json) = serde_json::from_str::<Value>(raw_str) {
            parse_content_blocks(&raw_json)
        } else {
            Vec::new()
        }
    } else {
        // 直接解析消息本身（可能已经是完整的 JSON 对象）
        parse_content_blocks(message)
    };

    if !blocks.is_empty() {
        if let Some(obj) = message.as_object_mut() {
            obj.insert(
                "contentBlocks".to_string(),
                serde_json::to_value(&blocks).unwrap_or(Value::Array(vec![])),
            );
        }
    }
}

/// 批量为消息添加 contentBlocks
pub fn enrich_messages_with_content_blocks(messages: &mut [Value]) {
    for message in messages.iter_mut() {
        enrich_message_with_content_blocks(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_parse_text_content() {
        let raw = json!({
            "message": {
                "content": "Hello, world!"
            }
        });

        let blocks = parse_content_blocks(&raw);
        assert_eq!(blocks.len(), 1);

        if let ContentBlock::Text { text } = &blocks[0] {
            assert_eq!(text, "Hello, world!");
        } else {
            panic!("Expected Text block");
        }
    }

    #[test]
    fn test_parse_tool_use() {
        let raw = json!({
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "tool_123",
                        "name": "Read",
                        "input": {
                            "file_path": "/path/to/file.rs"
                        }
                    }
                ]
            }
        });

        let blocks = parse_content_blocks(&raw);
        assert_eq!(blocks.len(), 1);

        if let ContentBlock::ToolUse { name, display_text, .. } = &blocks[0] {
            assert_eq!(name, "Read");
            assert!(display_text.as_ref().unwrap().contains("file.rs"));
        } else {
            panic!("Expected ToolUse block");
        }
    }

    #[test]
    fn test_parse_tool_result() {
        let raw = json!({
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tool_123",
                        "is_error": false,
                        "content": "File content here"
                    }
                ]
            }
        });

        let blocks = parse_content_blocks(&raw);
        assert_eq!(blocks.len(), 1);

        if let ContentBlock::ToolResult { content, is_error, .. } = &blocks[0] {
            assert_eq!(content, "File content here");
            assert!(!is_error);
        } else {
            panic!("Expected ToolResult block");
        }
    }

    #[test]
    fn test_parse_thinking() {
        let raw = json!({
            "message": {
                "content": [
                    {
                        "type": "thinking",
                        "thinking": "Let me think about this..."
                    }
                ]
            }
        });

        let blocks = parse_content_blocks(&raw);
        assert_eq!(blocks.len(), 1);

        if let ContentBlock::Thinking { thinking } = &blocks[0] {
            assert_eq!(thinking, "Let me think about this...");
        } else {
            panic!("Expected Thinking block");
        }
    }

    #[test]
    fn test_enrich_message() {
        let mut message = json!({
            "uuid": "msg_123",
            "raw": "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Hello\"}]}}"
        });

        enrich_message_with_content_blocks(&mut message);

        assert!(message.get("contentBlocks").is_some());
        let blocks = message.get("contentBlocks").unwrap().as_array().unwrap();
        assert_eq!(blocks.len(), 1);
    }
}
