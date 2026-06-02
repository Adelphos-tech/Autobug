#!/bin/bash
#
# Deploy Autobug to VPN Server
# Copies local files and runs installation
#

set -e

# Server details
SERVER="156.67.105.64"
USER="root"
PASSWORD="30rZNitUz*un6vgz"
DOMAIN="autobug.adelphostech.com"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Deploying Autobug to VPN Server...${NC}"
echo "Server: ${SERVER}"
echo "Domain: ${DOMAIN}"
echo ""

# Check if sshpass is installed
if ! command -v sshpass &> /dev/null; then
    echo -e "${YELLOW}Installing sshpass...${NC}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install hudochenkov/sshpass/sshpass
    else
        apt-get install -y sshpass
    fi
fi

# Create deployment package
echo -e "${YELLOW}Creating deployment package...${NC}"
cd /Users/shivang/Desktop/Autobug

# Create temporary deployment directory
DEPLOY_DIR="/tmp/autobug-deploy-$(date +%s)"
mkdir -p ${DEPLOY_DIR}

# Copy essential files
cp -r src ${DEPLOY_DIR}/
cp -r prisma ${DEPLOY_DIR}/
cp package.json ${DEPLOY_DIR}/
cp install-vpn-server.sh ${DEPLOY_DIR}/
cp safe-auto-dispatcher.js ${DEPLOY_DIR}/
cp prompt-generator.js ${DEPLOY_DIR}/
cp .env.example ${DEPLOY_DIR}/
cp -r src/services ${DEPLOY_DIR}/src/ 2>/dev/null || true
cp -r src/validation ${DEPLOY_DIR}/src/ 2>/dev/null || true

# Create tar archive
tar -czf /tmp/autobug.tar.gz -C ${DEPLOY_DIR} .

echo -e "${GREEN}✅ Deployment package created${NC}"

# Upload to server
echo -e "${YELLOW}Uploading to server...${NC}"
sshpass -p "${PASSWORD}" scp -o StrictHostKeyChecking=no /tmp/autobug.tar.gz ${USER}@${SERVER}:/tmp/

echo -e "${GREEN}✅ Files uploaded${NC}"

# Run installation on server
echo -e "${YELLOW}Running installation on server...${NC}"
sshpass -p "${PASSWORD}" ssh -o StrictHostKeyChecking=no ${USER}@${SERVER} << 'REMOTE_SCRIPT'

# Extract files
mkdir -p /opt/autobug
cd /opt/autobug
tar -xzf /tmp/autobug.tar.gz

# Make install script executable
chmod +x install-vpn-server.sh

# Run installation (this will take a few minutes)
./install-vpn-server.sh

REMOTE_SCRIPT

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Deployment Complete!                               ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Access your Autobug system:${NC}"
echo "  https://${DOMAIN}"
echo "  https://${DOMAIN}/admin"
echo ""
echo -e "${YELLOW}Server SSH Access:${NC}"
echo "  ssh root@${SERVER}"
echo "  Password: ${PASSWORD}"
echo ""
echo -e "${YELLOW}Useful commands on server:${NC}"
echo "  cd /opt/autobug"
echo "  ./start.sh      # Start services"
echo "  ./stop.sh       # Stop services"
echo "  ./logs.sh       # View logs"
echo ""

# Cleanup
rm -rf ${DEPLOY_DIR}
rm -f /tmp/autobug.tar.gz
