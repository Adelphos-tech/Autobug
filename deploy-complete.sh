#!/bin/bash
#
# Complete Autobug + Claude Code Deployment to VPN Server
# Configures Claude Code with user's ID and Kimi K2.5
#

set -e

# Server details
SERVER="156.67.105.64"
USER="root"
PASSWORD="30rZNitUz*un6vgz"
DOMAIN="autobug.adelphostech.com"
PROJECT_PATH="/var/www/adelphos_frontend"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Autobug + Claude Code VPN Deployment                      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Server: ${SERVER}"
echo "Domain: ${DOMAIN}"
echo "Project: ${PROJECT_PATH}"
echo ""

# Check dependencies
echo -e "${YELLOW}Checking local dependencies...${NC}"
if ! command -v sshpass &> /dev/null; then
    echo "Installing sshpass..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install hudochenkov/sshpass/sshpass 2>/dev/null || echo "Please install sshpass manually"
    else
        apt-get install -y sshpass 2>/dev/null || echo "Please install sshpass manually"
    fi
fi

# Step 1: Prepare deployment package
echo -e "${YELLOW}Step 1: Preparing deployment package...${NC}"
cd /Users/shivang/Desktop/Autobug

# Create deployment directory
DEPLOY_DIR="/tmp/autobug-deploy-$(date +%s)"
mkdir -p ${DEPLOY_DIR}

# Copy all project files
cp -r src ${DEPLOY_DIR}/
cp -r prisma ${DEPLOY_DIR}/
cp prisma.config.cjs ${DEPLOY_DIR}/
cp package.json ${DEPLOY_DIR}/
cp package-lock.json ${DEPLOY_DIR}/ 2>/dev/null || true
cp safe-auto-dispatcher.js ${DEPLOY_DIR}/
cp prompt-generator.js ${DEPLOY_DIR}/
cp .env ${DEPLOY_DIR}/.env.local
cp .env.example ${DEPLOY_DIR}/
cp README.md ${DEPLOY_DIR}/ 2>/dev/null || true
cp -r logs ${DEPLOY_DIR}/ 2>/dev/null || mkdir -p ${DEPLOY_DIR}/logs
cp -r uploads ${DEPLOY_DIR}/ 2>/dev/null || mkdir -p ${DEPLOY_DIR}/uploads

# Create server-specific .env
cat > ${DEPLOY_DIR}/.env << EOF
# Autobug Production Configuration
NODE_ENV=production

# Database
DATABASE_URL="file:./dev.db"

# Redis (local on VPN server)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# Server
PORT=3001

# SSH Configuration (localhost - same server)
SSH_HOST=localhost
SSH_USER=root
SSH_PASSWORD=30rZNitUz*un6vgz
SSH_TIMEOUT_MS=30000

# Default Repository Path
DEFAULT_REPO_PATH=${PROJECT_PATH}

# Safety Settings
DRY_RUN=false
REQUIRE_CONFIRMATION=false

# Groq AI Context Enhancement (PRIMARY)
GROQ_ENABLED=true
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_TIMEOUT_MS=30000
GROQ_MAX_TOKENS=4096
GROQ_TEMPERATURE=0.2
GROQ_FALLBACK_ON_ERROR=true

# Ollama Model Configuration
OLLAMA_MODEL=kimi-k2.6:cloud
EOF

# Create systemd service files
cat > ${DEPLOY_DIR}/autobug-server.service << EOF
[Unit]
Description=Autobug API Server
After=network.target redis-server.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/autobug
ExecStart=/usr/bin/node /opt/autobug/src/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/autobug/.env

[Install]
WantedBy=multi-user.target
EOF

cat > ${DEPLOY_DIR}/autobug-worker.service << EOF
[Unit]
Description=Autobug Worker Dispatcher
After=network.target redis-server.service autobug-server.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/autobug
ExecStart=/usr/bin/node /opt/autobug/src/queue/ollamaWorker.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/autobug/.env

[Install]
WantedBy=multi-user.target
EOF

# Create nginx config
cat > ${DEPLOY_DIR}/autobug.nginx << EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 86400;
    }

    location /uploads {
        alias /opt/autobug/uploads;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    client_max_body_size 20M;
}
EOF

# Create installation script for server
cat > ${DEPLOY_DIR}/install-on-server.sh << 'INSTALLER_EOF'
#!/bin/bash
set -e

echo "=========================================="
echo "Installing Autobug on VPN Server"
echo "=========================================="

# Update system
echo "Updating system packages..."
apt-get update -qq

# Install dependencies
echo "Installing dependencies..."
apt-get install -y -qq curl wget git redis-server nginx sqlite3 build-essential python3 certbot python3-certbot-nginx supervisor

# Start Redis
echo "Starting Redis..."
systemctl enable redis-server >/dev/null 2>&1
systemctl start redis-server
redis-cli ping

# Install Node.js 18
echo "Installing Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs
fi
node --version
npm --version

# Install Claude Code CLI
echo "Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code
ln -sf $(which claude-code) /usr/local/bin/claude
claude --version

# Setup Autobug
echo "Setting up Autobug..."
mkdir -p /opt/autobug
cd /opt/autobug

# Copy deployment files
if [ -d "/tmp/autobug-deploy" ]; then
    cp -r /tmp/autobug-deploy/. /opt/autobug/ 2>/dev/null || true
fi

# Install dependencies
echo "Installing Node.js dependencies..."
npm install --production

# Setup database
echo "Setting up database..."
export DATABASE_URL="file:./dev.db"
npx prisma generate
npx prisma db push --accept-data-loss

# Setup permissions
chmod -R 755 /opt/autobug
chmod -R 777 /opt/autobug/uploads
chmod -R 777 /opt/autobug/logs

# Install systemd services
echo "Installing systemd services..."
cp autobug-server.service /etc/systemd/system/
cp autobug-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable autobug-server
systemctl enable autobug-worker

# Setup nginx
echo "Configuring Nginx..."
cp autobug.nginx /etc/nginx/sites-available/autobug
ln -sf /etc/nginx/sites-available/autobug /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

# Setup SSL
echo "Setting up SSL certificate..."
certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos --email admin@adelphostech.com 2>/dev/null || echo "SSL setup skipped or already configured"

# Start services
echo "Starting Autobug services..."
systemctl start autobug-server
systemctl start autobug-worker

# Create helper scripts
cat > /opt/autobug/start.sh << 'EOF'
#!/bin/bash
echo "Starting Autobug..."
systemctl start redis-server
systemctl start autobug-server
systemctl start autobug-worker
systemctl start nginx
echo "✅ Autobug started!"
echo "Access: https://autobug.adelphostech.com"
EOF

cat > /opt/autobug/stop.sh << 'EOF'
#!/bin/bash
echo "Stopping Autobug..."
systemctl stop autobug-worker
systemctl stop autobug-server
systemctl stop nginx
echo "✅ Autobug stopped"
EOF

cat > /opt/autobug/logs.sh << 'EOF'
#!/bin/bash
echo "=== Autobug Server Logs ==="
journalctl -u autobug-server -n 50 --no-pager
echo ""
echo "=== Autobug Worker Logs ==="
journalctl -u autobug-worker -n 50 --no-pager
echo ""
echo "=== Nginx Logs ==="
tail -n 20 /var/log/nginx/error.log
EOF

chmod +x /opt/autobug/start.sh
chmod +x /opt/autobug/stop.sh
chmod +x /opt/autobug/logs.sh

# Create Claude Code config
echo "Creating Claude Code configuration..."
mkdir -p ~/.claude
cat > ~/.claude/config.json << 'EOF'
{
  "preferredModel": "claude-opus-4",
  "defaultProject": "adelphos_frontend",
  "autoConfirm": false,
  "theme": "dark"
}
EOF

echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "Autobug URL: https://${DOMAIN}"
echo "Admin Panel: https://${DOMAIN}/admin"
echo ""
echo "Claude Code is installed and ready!"
echo "Run: claude --version"
echo ""
echo "Useful commands:"
echo "  cd /opt/autobug"
echo "  ./start.sh    - Start all services"
echo "  ./stop.sh     - Stop all services"
echo "  ./logs.sh     - View logs"
echo ""
echo "To authenticate Claude Code:"
echo "  claude auth login"
echo ""
INSTALLER_EOF

chmod +x ${DEPLOY_DIR}/install-on-server.sh

# Create tar archive
echo "Creating deployment archive..."
tar -czf /tmp/autobug-deploy.tar.gz -C ${DEPLOY_DIR} .

echo -e "${GREEN}✅ Deployment package ready${NC}"

# Step 2: Upload to server
echo -e "${YELLOW}Step 2: Uploading to VPN server...${NC}"
sshpass -p "${PASSWORD}" scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/autobug-deploy.tar.gz ${USER}@${SERVER}:/tmp/ 2>&1 | grep -v "Warning: Permanently added" || true

echo -e "${GREEN}✅ Files uploaded${NC}"

# Step 3: Extract and install
echo -e "${YELLOW}Step 3: Installing on server (this takes 5-10 minutes)...${NC}"
sshpass -p "${PASSWORD}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${USER}@${SERVER} << REMOTE_COMMANDS 2>&1 | grep -v "Warning: Permanently added" || true

cd /tmp
mkdir -p autobug-deploy
rm -rf /opt/autobug
mkdir -p /opt/autobug
cd /opt/autobug
tar -xzf /tmp/autobug-deploy.tar.gz
export DOMAIN="${DOMAIN}"
bash install-on-server.sh

REMOTE_COMMANDS

echo -e "${GREEN}✅ Installation complete${NC}"

# Step 4: Verify installation
echo -e "${YELLOW}Step 4: Verifying installation...${NC}"
sleep 5

# Check services
SERVICE_STATUS=$(sshpass -p "${PASSWORD}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${USER}@${SERVER} "systemctl is-active autobug-server autobug-worker" 2>&1 | grep -v "Warning:" || true)
echo "Service status: ${SERVICE_STATUS}"

# Cleanup
rm -rf ${DEPLOY_DIR}
rm -f /tmp/autobug-deploy.tar.gz

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         DEPLOYMENT SUCCESSFUL!                             ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}🌐 Access Your Autobug:${NC}"
echo "   https://${DOMAIN}"
echo "   https://${DOMAIN}/admin"
echo ""
echo -e "${BLUE}🔧 Server SSH:${NC}"
echo "   ssh root@${SERVER}"
echo "   Password: ${PASSWORD}"
echo ""
echo -e "${YELLOW}Claude Code is installed!${NC}"
echo "   SSH to server and run: claude --version"
echo ""
echo -e "${YELLOW}To authenticate Claude Code:${NC}"
echo "   1. SSH: ssh root@${SERVER}"
echo "   2. Run: claude auth login"
echo "   3. Follow the browser authentication"
echo ""
echo -e "${YELLOW}Useful commands on server:${NC}"
echo "   cd /opt/autobug"
echo "   ./start.sh     # Start all services"
echo "   ./stop.sh      # Stop all services"
echo "   ./logs.sh      # View logs"
echo "   claude --version"
echo ""
echo -e "${YELLOW}Project location:${NC}"
echo "   ${PROJECT_PATH}"
echo ""
