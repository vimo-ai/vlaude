#!/bin/bash

# Vlaude 环境切换脚本
# 用法: ./scripts/switch-env.sh [nas|local|status]
#
# 同时切换 iOS 和 ETerm 的 Server 地址

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# 配置
NAS_HOST="***REMOVED-domain***"
NAS_PORT=10005
LOCAL_HOST="10.0.0.1"

# 文件路径
IOS_CONFIG="$PROJECT_ROOT/packages/Vlaude/Vlaude/Services/VlaudeConfig.swift"
ETERM_CONFIG="$HOME/.eterm/config/vlaude.json"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

show_usage() {
    echo "用法: $0 [nas|local|status]"
    echo ""
    echo "  nas    - 切换到 NAS 环境 (https://$NAS_HOST:$NAS_PORT)"
    echo "  local  - 切换到本地环境 (https://$LOCAL_HOST:$NAS_PORT)"
    echo "  status - 显示当前环境"
    echo ""
    echo "影响范围:"
    echo "  iOS:   VlaudeConfig.swift (serverHost 硬编码)"
    echo "  ETerm: ~/.eterm/config/vlaude.json (serverURL 运行时配置)"
    echo ""
    echo "注意: ETerm 端改配置后需要重启 VlaudeKit 插件生效"
}

get_ios_env() {
    if grep -q "\"$NAS_HOST\"" "$IOS_CONFIG" 2>/dev/null; then
        echo "nas"
    else
        echo "local"
    fi
}

get_eterm_env() {
    if [ -f "$ETERM_CONFIG" ]; then
        if grep -q "$NAS_HOST" "$ETERM_CONFIG" 2>/dev/null; then
            echo "nas"
        elif grep -q "serverURL" "$ETERM_CONFIG" 2>/dev/null; then
            local url=$(python3 -c "import json; print(json.load(open('$ETERM_CONFIG')).get('serverURL', ''))" 2>/dev/null)
            if [ -z "$url" ] || [ "$url" = "" ]; then
                echo "default (localhost)"
            else
                echo "custom: $url"
            fi
        else
            echo "unknown"
        fi
    else
        echo "未配置"
    fi
}

switch_to_nas() {
    echo -e "${YELLOW}切换到 NAS 环境...${NC}"
    echo ""

    # 1. iOS: 修改 VlaudeConfig.swift 中的 serverHost
    if [ -f "$IOS_CONFIG" ]; then
        sed -i '' "s|static let serverHost = \".*\"|static let serverHost = \"$NAS_HOST\"|" "$IOS_CONFIG"
        echo -e "  ${GREEN}✓${NC} iOS VlaudeConfig.swift → $NAS_HOST"
    else
        echo -e "  ${RED}✗${NC} iOS VlaudeConfig.swift 不存在"
    fi

    # 2. ETerm: 修改 vlaude.json（保留已有字段，补全缺失字段）
    if [ -f "$ETERM_CONFIG" ]; then
        python3 -c "
import json, os
defaults = {
    'daemonTTL': 30,
    'deviceId': 'eterm',
    'deviceName': os.uname().nodename or 'Mac',
    'enabled': True,
    'redisPort': 6379,
}
with open('$ETERM_CONFIG', 'r') as f:
    config = json.load(f)
# 补全缺失字段
for k, v in defaults.items():
    config.setdefault(k, v)
# 设置 NAS 环境
config['serverURL'] = 'https://$NAS_HOST:$NAS_PORT'
config['redisHost'] = '$NAS_HOST'
config['redisPassword'] = '***REMOVED-redis***'
with open('$ETERM_CONFIG', 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False, sort_keys=True)
"
        echo -e "  ${GREEN}✓${NC} ETerm vlaude.json → https://$NAS_HOST:$NAS_PORT"
    else
        echo -e "  ${RED}✗${NC} ETerm vlaude.json 不存在 ($ETERM_CONFIG)"
    fi

    echo ""
    echo -e "${GREEN}已切换到 NAS 环境${NC}"
    echo -e "  Server: ${YELLOW}https://$NAS_HOST:$NAS_PORT${NC}"
    echo ""
    echo -e "${YELLOW}下一步:${NC}"
    echo "  iOS:   重新编译安装"
    echo "  ETerm: 重启 VlaudeKit 插件（或重启 ETerm）"
}

switch_to_local() {
    echo -e "${YELLOW}切换到本地环境...${NC}"
    echo ""

    # 1. iOS
    if [ -f "$IOS_CONFIG" ]; then
        sed -i '' "s|static let serverHost = \".*\"|static let serverHost = \"$LOCAL_HOST\"|" "$IOS_CONFIG"
        echo -e "  ${GREEN}✓${NC} iOS VlaudeConfig.swift → $LOCAL_HOST"
    else
        echo -e "  ${RED}✗${NC} iOS VlaudeConfig.swift 不存在"
    fi

    # 2. ETerm: 修改 vlaude.json（保留已有字段，补全缺失字段）
    if [ -f "$ETERM_CONFIG" ]; then
        python3 -c "
import json, os
defaults = {
    'daemonTTL': 30,
    'deviceId': 'eterm',
    'deviceName': os.uname().nodename or 'Mac',
    'enabled': True,
    'redisPort': 6379,
}
with open('$ETERM_CONFIG', 'r') as f:
    config = json.load(f)
# 补全缺失字段
for k, v in defaults.items():
    config.setdefault(k, v)
# 设置本地环境
config['serverURL'] = ''
config['redisHost'] = 'localhost'
config['redisPassword'] = None
with open('$ETERM_CONFIG', 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False, sort_keys=True)
"
        echo -e "  ${GREEN}✓${NC} ETerm vlaude.json → localhost (default)"
    else
        echo -e "  ${RED}✗${NC} ETerm vlaude.json 不存在 ($ETERM_CONFIG)"
    fi

    echo ""
    echo -e "${GREEN}已切换到本地环境${NC}"
    echo -e "  Server: ${YELLOW}https://localhost:$NAS_PORT${NC}"
    echo ""
    echo -e "${YELLOW}下一步:${NC}"
    echo "  iOS:   重新编译安装"
    echo "  ETerm: 重启 VlaudeKit 插件（或重启 ETerm）"
}

show_status() {
    echo "当前环境:"
    echo ""
    echo -e "  iOS (VlaudeConfig.swift):"
    if [ -f "$IOS_CONFIG" ]; then
        local ios_host=$(grep 'static let serverHost' "$IOS_CONFIG" | sed 's/.*= "\(.*\)"/\1/')
        echo -e "    serverHost = ${YELLOW}$ios_host${NC}"
    else
        echo -e "    ${RED}文件不存在${NC}"
    fi

    echo ""
    echo -e "  ETerm (vlaude.json):"
    if [ -f "$ETERM_CONFIG" ]; then
        local eterm_url=$(python3 -c "import json; print(json.load(open('$ETERM_CONFIG')).get('serverURL', '(空)'))" 2>/dev/null)
        local eterm_redis=$(python3 -c "import json; print(json.load(open('$ETERM_CONFIG')).get('redisHost', '(空)'))" 2>/dev/null)
        echo -e "    serverURL = ${YELLOW}${eterm_url:-(空，默认 localhost)}${NC}"
        echo -e "    redisHost = ${YELLOW}$eterm_redis${NC}"
    else
        echo -e "    ${RED}文件不存在${NC}"
    fi
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
