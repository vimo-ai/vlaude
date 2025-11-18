#!/bin/bash

# 强制触发会话更新(通过清空消息缓存)

SESSION_ID="9ada9db9-5acc-41a0-8774-53164fe76f77"
PROJECT_PATH="/Users/higuaifan/Desktop/hi/小工具/claude/packages/vlaude-cli"
ENCODED_PATH=$(echo -n "$PROJECT_PATH" | jq -sRr @uri)

echo "========================================="
echo "触发会话更新"
echo "========================================="
echo ""

echo "1. 删除该会话的消息缓存..."
# 这里需要直接操作数据库或调用 API
# 暂时通过修改 lastParsedLine 来触发
echo "TODO: 需要添加清理缓存的 API"
echo ""

echo "2. 重新请求会话列表（触发增量更新）..."
RESPONSE=$(curl -s "http://localhost:10005/sessions/by-path?path=$ENCODED_PATH&limit=1")
echo "$RESPONSE" | jq '.'
echo ""

echo "3. 检查 messages 字段..."
MESSAGES_COUNT=$(echo "$RESPONSE" | jq '.data[0].messages | length')
echo "messages 数组长度: $MESSAGES_COUNT"

if [ "$MESSAGES_COUNT" -gt 0 ]; then
    echo ""
    echo "✅ 成功！最后一条消息："
    echo "$RESPONSE" | jq '.data[0].messages[0]'
else
    echo ""
    echo "❌ 仍然为空，需要检查 Server 日志"
fi
