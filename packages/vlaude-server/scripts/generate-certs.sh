#!/bin/bash

# mTLS 证书生成脚本 (iOS 兼容版)
# 用法: ./scripts/generate-certs.sh

set -e

CERT_DIR="./certs"
DAYS_VALID=825  # iOS 最大允许 825 天

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== mTLS 证书生成脚本 (iOS 兼容版) ===${NC}"

# 创建证书目录
mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

# ========================================
# 1. 生成 CA 证书（证书颁发机构）
# ========================================
echo -e "\n${YELLOW}[1/4] 生成 CA 证书...${NC}"

if [ ! -f "ca.key" ]; then
    # CA 配置文件
    cat > ca.cnf << EOF
[req]
default_bits = 4096
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_ca

[dn]
C = CN
ST = Shanghai
L = Shanghai
O = Vlaude
OU = CA
CN = Vlaude Root CA

[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF

    # 生成 CA 私钥
    openssl genrsa -out ca.key 4096

    # 生成 CA 证书
    openssl req -x509 -new -nodes \
        -key ca.key \
        -sha256 \
        -days $DAYS_VALID \
        -out ca.crt \
        -config ca.cnf

    echo -e "${GREEN}✅ CA 证书已生成${NC}"
else
    echo -e "${YELLOW}⚠️  CA 证书已存在，跳过${NC}"
fi

# ========================================
# 2. 生成服务端证书
# ========================================
echo -e "\n${YELLOW}[2/4] 生成服务端证书...${NC}"

if [ ! -f "server.key" ]; then
    # 服务端证书配置（iOS 兼容）
    cat > server.cnf << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
C = CN
ST = Shanghai
L = Shanghai
O = Vlaude
OU = Server
CN = vlaude-server

[req_ext]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = vlaude-server
DNS.3 = *.local
DNS.4 = homenas.higuaifan.com
IP.1 = 127.0.0.1
IP.2 = 192.168.50.229
IP.3 = 192.168.50.9
EOF

    # 签发用的扩展配置
    cat > server_ext.cnf << EOF
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost, DNS:vlaude-server, DNS:*.local, DNS:homenas.higuaifan.com, IP:127.0.0.1, IP:192.168.50.229, IP:192.168.50.9
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

    # 生成服务端私钥
    openssl genrsa -out server.key 2048

    # 生成服务端 CSR
    openssl req -new \
        -key server.key \
        -out server.csr \
        -config server.cnf

    # 用 CA 签发服务端证书
    openssl x509 -req \
        -in server.csr \
        -CA ca.crt \
        -CAkey ca.key \
        -CAcreateserial \
        -out server.crt \
        -days $DAYS_VALID \
        -sha256 \
        -extfile server_ext.cnf

    echo -e "${GREEN}✅ 服务端证书已生成${NC}"
else
    echo -e "${YELLOW}⚠️  服务端证书已存在，跳过${NC}"
fi

# ========================================
# 3. 生成客户端证书（iOS 设备用）
# ========================================
echo -e "\n${YELLOW}[3/4] 生成客户端证书...${NC}"

CLIENT_NAME="ios-client"

if [ ! -f "${CLIENT_NAME}.key" ]; then
    # 客户端证书扩展配置
    cat > client_ext.cnf << EOF
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

    # 生成客户端私钥
    openssl genrsa -out ${CLIENT_NAME}.key 2048

    # 生成客户端 CSR
    openssl req -new \
        -key ${CLIENT_NAME}.key \
        -out ${CLIENT_NAME}.csr \
        -subj "/C=CN/ST=Shanghai/L=Shanghai/O=Vlaude/OU=Client/CN=iOS Client"

    # 用 CA 签发客户端证书
    openssl x509 -req \
        -in ${CLIENT_NAME}.csr \
        -CA ca.crt \
        -CAkey ca.key \
        -CAcreateserial \
        -out ${CLIENT_NAME}.crt \
        -days $DAYS_VALID \
        -sha256 \
        -extfile client_ext.cnf

    # 打包成 iOS 可用的 p12 格式
    openssl pkcs12 -export \
        -out ${CLIENT_NAME}.p12 \
        -inkey ${CLIENT_NAME}.key \
        -in ${CLIENT_NAME}.crt \
        -certfile ca.crt \
        -passout pass:vlaude123

    echo -e "${GREEN}✅ 客户端证书已生成${NC}"
    echo -e "${GREEN}   P12 密码: vlaude123${NC}"
else
    echo -e "${YELLOW}⚠️  客户端证书已存在，跳过${NC}"
fi

# ========================================
# 4. 清理临时文件
# ========================================
echo -e "\n${YELLOW}[4/4] 清理临时文件...${NC}"
rm -f *.csr *.cnf *.srl

# ========================================
# 验证证书
# ========================================
echo -e "\n${YELLOW}=== 验证证书 ===${NC}"
echo "服务端证书扩展:"
openssl x509 -in server.crt -text -noout | grep -A 5 "X509v3 extensions" | head -10

# ========================================
# 输出结果
# ========================================
echo -e "\n${GREEN}=== 证书生成完成 ===${NC}"
echo -e "证书目录: ${CERT_DIR}"
echo ""
echo "生成的文件:"
ls -la

echo -e "\n${YELLOW}=== 下一步操作 ===${NC}"
echo "1. 服务端: 证书已就绪，启动服务即可"
echo ""
echo "2. iOS 客户端:"
echo "   - 将 ${CLIENT_NAME}.p12 复制到 iOS 项目"
echo "   - 将 ca.crt 复制到 iOS 项目（用于验证服务端证书）"
echo "   - P12 导入密码: vlaude123"
echo ""
echo -e "${RED}⚠️  安全提示:${NC}"
echo "   - ca.key 是根证书私钥，请妥善保管，切勿泄露！"
echo "   - 不要将 certs 目录提交到 git"
