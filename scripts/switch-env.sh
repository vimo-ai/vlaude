#!/bin/bash

# Vlaude 环境切换脚本
# 用法: ./scripts/switch-env.sh [nas|local]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# 配置
NAS_HOST="homenas.higuaifan.com"
LOCAL_HOST="localhost"

# 文件路径
SWIFT_API_CLIENT="$PROJECT_ROOT/packages/Vlaude/Vlaude/Services/APIClient.swift"
SWIFT_WS_MANAGER="$PROJECT_ROOT/packages/Vlaude/Vlaude/Services/WebSocketManager.swift"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

show_usage() {
    echo "用法: $0 [nas|local|status]"
    echo ""
    echo "  nas    - 切换到 NAS 环境 (https://$NAS_HOST:10005)"
    echo "  local  - 切换到本地环境 (https://$LOCAL_HOST:10005)"
    echo "  status - 显示当前环境"
    echo ""
}

get_current_env() {
    if grep -q "$NAS_HOST" "$SWIFT_API_CLIENT" 2>/dev/null; then
        echo "nas"
    else
        echo "local"
    fi
}

switch_to_nas() {
    echo -e "${YELLOW}切换到 NAS 环境...${NC}"

    # Swift APIClient - 只替换 baseURL 赋值行
    sed -i '' "s|://localhost:10005|://$NAS_HOST:10005|g" "$SWIFT_API_CLIENT"
    echo -e "  ${GREEN}✓${NC} APIClient.swift"

    # Swift WebSocketManager - 只替换 URL 赋值行
    sed -i '' "s|://localhost:10005|://$NAS_HOST:10005|g" "$SWIFT_WS_MANAGER"
    echo -e "  ${GREEN}✓${NC} WebSocketManager.swift"

    echo ""
    echo -e "${GREEN}已切换到 NAS 环境${NC}"
    echo -e "  Server: ${YELLOW}https://$NAS_HOST:10005${NC}"
    echo -e "${YELLOW}注意: Daemon 现在通过 Redis 服务发现自动连接${NC}"
}

switch_to_local() {
    echo -e "${YELLOW}切换到本地环境...${NC}"

    # Swift APIClient
    sed -i '' "s|://$NAS_HOST:10005|://localhost:10005|g" "$SWIFT_API_CLIENT"
    echo -e "  ${GREEN}✓${NC} APIClient.swift"

    # Swift WebSocketManager
    sed -i '' "s|://$NAS_HOST:10005|://localhost:10005|g" "$SWIFT_WS_MANAGER"
    echo -e "  ${GREEN}✓${NC} WebSocketManager.swift"

    echo ""
    echo -e "${GREEN}已切换到本地环境${NC}"
    echo -e "  Server: ${YELLOW}https://localhost:10005${NC}"
    echo -e "${YELLOW}注意: Daemon 现在通过 Redis 服务发现自动连接${NC}"
}

show_status() {
    local current=$(get_current_env)
    echo -e "当前环境: ${YELLOW}$current${NC}"
    echo ""
    echo "文件状态:"

    # 检查各文件
    if grep -q "$NAS_HOST" "$SWIFT_API_CLIENT" 2>/dev/null; then
        echo -e "  APIClient.swift:          ${GREEN}NAS${NC}"
    else
        echo -e "  APIClient.swift:          ${YELLOW}LOCAL${NC}"
    fi

    if grep -q "$NAS_HOST" "$SWIFT_WS_MANAGER" 2>/dev/null; then
        echo -e "  WebSocketManager.swift:   ${GREEN}NAS${NC}"
    else
        echo -e "  WebSocketManager.swift:   ${YELLOW}LOCAL${NC}"
    fi

    echo ""
    echo -e "${YELLOW}注意: Daemon 现在通过 Redis 服务发现自动连接，无需手动切换${NC}"
}

# 主逻辑
case "$1" in
    nas)
        switch_to_nas
        ;;
    local)
        switch_to_local
        ;;
    status)
        show_status
        ;;
    *)
        show_usage
        exit 1
        ;;
esac
