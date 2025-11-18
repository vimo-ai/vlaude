#!/bin/bash

# 测试会话列表 API 返回数据

PROJECT_PATH="/Users/higuaifan/Desktop/hi/小工具/claude/packages/vlaude-cli"
ENCODED_PATH=$(echo -n "$PROJECT_PATH" | jq -sRr @uri)

echo "========================================="
echo "测试会话列表 API"
echo "========================================="
echo ""
echo "项目路径: $PROJECT_PATH"
echo "URL编码: $ENCODED_PATH"
echo ""

echo "1. 调用 Server API 获取会话列表"
echo "-----------------------------------------"
RESPONSE=$(curl -s "http://localhost:10005/sessions/by-path?path=$ENCODED_PATH&limit=1")

echo "$RESPONSE" | jq '.'
echo ""

echo "2. 检查返回的 messages 字段"
echo "-----------------------------------------"
MESSAGES_COUNT=$(echo "$RESPONSE" | jq '.data[0].messages | length')
echo "messages 数组长度: $MESSAGES_COUNT"

if [ "$MESSAGES_COUNT" -eq 0 ]; then
    echo ""
    echo "❌ 问题：messages 数组为空"
    echo ""
    echo "3. 检查会话元数据"
    echo "-----------------------------------------"
    echo "$RESPONSE" | jq '.data[0] | {
        sessionId,
        messageCount,
        lastMessageAt,
        lastMtime,
        lastParsedLine
    }'
    echo ""

    echo "4. 尝试直接查询该会话的消息"
    echo "-----------------------------------------"
    SESSION_ID=$(echo "$RESPONSE" | jq -r '.data[0].sessionId')
    echo "Session ID: $SESSION_ID"

    MESSAGE_RESPONSE=$(curl -s "http://localhost:10005/sessions/by-session-id/$SESSION_ID")
    echo "$MESSAGE_RESPONSE" | jq '.data | {
        sessionId,
        messageCount,
        messages: (.messages | length)
    }'
else
    echo ""
    echo "✅ messages 数组有数据"
    echo ""
    echo "3. 查看第一条消息"
    echo "-----------------------------------------"
    echo "$RESPONSE" | jq '.data[0].messages[0]'
fi

echo ""
echo "========================================="
echo "测试完成"
echo "========================================="
