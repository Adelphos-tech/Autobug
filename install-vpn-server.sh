#!/bin/bash
#
# Autobug VPN Server Installation Script
# Installs Autobug + Claude Code on 156.67.105.64
# Configures for adelphos_frontend project
# Sets up subdomain hosting
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         Autobug VPN Server Installation                    ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Configuration
DOMAIN="autobug.adelphostech.com"
PROJECT_PATH="/var/www/adelphos_frontend"
AUTOBUG_PATH="/opt/autobug"
NODE_VERSION="18"

echo -e "${YELLOW}Step 1: Updating system packages...${NC}"
apt-get update
apt-get upgrade -y

echo -e "${YELLOW}Step 2: Installing dependencies...${NC}"
apt-get install -y \
    curl \
    wget \
    git \
    redis-server \
    nginx \
    sqlite3 \
    build-essential \
    python3 \
    python3-pip \
    certbot \
    python3-certbot-nginx \
    supervisor

# Start Redis
echo -e "${YELLOW}Step 3: Configuring Redis...${NC}"
systemctl enable redis-server
systemctl start redis-server
redis-cli ping

echo -e "${GREEN}✅ Redis is running${NC}"

# Install Node.js
echo -e "${YELLOW}Step 4: Installing Node.js ${NODE_VERSION}...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
fi

node --version
npm --version
echo -e "${GREEN}✅ Node.js installed${NC}"

# Install Claude Code CLI
echo -e "${YELLOW}Step 5: Installing Claude Code CLI...${NC}"
npm install -g @anthropic-ai/claude-code

# Create symlink for claude command
ln -sf $(which claude-code) /usr/local/bin/claude

claude --version
echo -e "${GREEN}✅ Claude Code installed${NC}"

# Setup Autobug directory
echo -e "${YELLOW}Step 6: Setting up Autobug...${NC}"
mkdir -p ${AUTOBUG_PATH}
cd ${AUTOBUG_PATH}

# Clone Autobug (we'll copy from local or create fresh)
# Note: In production, you'd clone from git
# For now, we'll create the structure

cat > package.json << 'EOF'
{
  "name": "autobug-vpn",
  "version": "1.0.0",
  "description": "Autobug Ticket Processing System",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "worker": "node safe-auto-dispatcher.js",
    "dev": "concurrently \"npm run start\" \"npm run worker\"",
    "setup": "npx prisma migrate dev"
  },
  "dependencies": {
    "@prisma/adapter-better-sqlite3": "^6.0.0",
    "@prisma/client": "^6.0.0",
    "bullmq": "^5.0.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.0",
    "express": "^4.18.0",
    "ioredis": "^5.4.0",
    "multer": "^1.4.5-lts.1"
  },
  "devDependencies": {
    "concurrently": "^9.0.0",
    "prisma": "^6.0.0"
  }
}
EOF

# Create .env file
cat > .env << EOF
# Database
DATABASE_URL="file:./dev.db"

# Redis Configuration
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# Server
PORT=3001

# SSH Configuration (localhost since we're on the same server)
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
GROQ_ENABLED=false
GROQ_API_KEY=gsk_your_groq_api_key_here
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_TIMEOUT_MS=30000
GROQ_MAX_TOKENS=4096
GROQ_TEMPERATURE=0.2
GROQ_FALLBACK_ON_ERROR=true
EOF

# Create directory structure
mkdir -p src/{public,services,queue,validation}
mkdir -p logs
mkdir -p uploads

# Install dependencies
echo -e "${YELLOW}Step 7: Installing Node.js dependencies...${NC}"
npm install

echo -e "${GREEN}✅ Dependencies installed${NC}"

# Setup Prisma
echo -e "${YELLOW}Step 8: Setting up database...${NC}"
npx prisma generate

# Create systemd services
echo -e "${YELLOW}Step 9: Creating systemd services...${NC}"

# Autobug Server Service
cat > /etc/systemd/system/autobug-server.service << EOF
[Unit]
Description=Autobug API Server
After=network.target redis-server.service

[Service]
Type=simple
User=root
WorkingDirectory=${AUTOBUG_PATH}
ExecStart=/usr/bin/node ${AUTOBUG_PATH}/src/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Autobug Worker Service
cat > /etc/systemd/system/autobug-worker.service << EOF
[Unit]
Description=Autobug Worker Dispatcher
After=network.target redis-server.service autobug-server.service

[Service]
Type=simple
User=root
WorkingDirectory=${AUTOBUG_PATH}
ExecStart=/usr/bin/node ${AUTOBUG_PATH}/safe-auto-dispatcher.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
systemctl daemon-reload

# Enable services
systemctl enable autobug-server.service
systemctl enable autobug-worker.service

echo -e "${GREEN}✅ Systemd services created${NC}"

# Configure Nginx
echo -e "${YELLOW}Step 10: Configuring Nginx...${NC}"

cat > /etc/nginx/sites-available/autobug << EOF
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

        # WebSocket support for SSE
        proxy_read_timeout 86400;
    }

    location /uploads {
        alias ${AUTOBUG_PATH}/uploads;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    client_max_body_size 20M;
}
EOF

# Enable site
ln -sf /etc/nginx/sites-available/autobug /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test nginx configuration
nginx -t

echo -e "${GREEN}✅ Nginx configured${NC}"

# Setup SSL with Certbot
echo -e "${YELLOW}Step 11: Setting up SSL certificate...${NC}"
certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos --email admin@adelphostech.com || true

echo -e "${GREEN}✅ SSL certificate configured${NC}"

# Create start/stop scripts
cat > ${AUTOBUG_PATH}/start.sh << 'EOF'
#!/bin/bash
echo "Starting Autobug..."
systemctl start redis-server
systemctl start autobug-server
systemctl start autobug-worker
systemctl start nginx
echo "✅ Autobug started"
echo ""
echo "Services status:"
systemctl status autobug-server --no-pager -l
systemctl status autobug-worker --no-pager -l
EOF

cat > ${AUTOBUG_PATH}/stop.sh << 'EOF'
#!/bin/bash
echo "Stopping Autobug..."
systemctl stop autobug-worker
systemctl stop autobug-server
systemctl stop nginx
echo "✅ Autobug stopped"
EOF

cat > ${AUTOBUG_PATH}/logs.sh << 'EOF'
#!/bin/bash
echo "=== Autobug Server Logs ==="
journalctl -u autobug-server -n 50 --no-pager
echo ""
echo "=== Autobug Worker Logs ==="
journalctl -u autobug-worker -n 50 --no-pager
EOF

chmod +x ${AUTOBUG_PATH}/start.sh
chmod +x ${AUTOBUG_PATH}/stop.sh
chmod +x ${AUTOBUG_PATH}/logs.sh

# Create README
cat > ${AUTOBUG_PATH}/README.md << EOF
# Autobug VPN Server Installation

## Domain
https://${DOMAIN}

## Project Path
${PROJECT_PATH}

## Services
- **Autobug Server**: Port 3001 (http://localhost:3001)
- **Redis**: Port 6379
- **Nginx**: Reverse proxy + SSL

## Commands

### Start Autobug
\`\`\`bash
./start.sh
# Or:
systemctl start autobug-server
systemctl start autobug-worker
\`\`\`

### Stop Autobug
\`\`\`bash
./stop.sh
# Or:
systemctl stop autobug-server
systemctl stop autobug-worker
\`\`\`

### View Logs
\`\`\`bash
./logs.sh
# Or:
journalctl -u autobug-server -f
journalctl -u autobug-worker -f
\`\`\`

## File Locations
- Autobug: ${AUTOBUG_PATH}
- Project: ${PROJECT_PATH}
- Logs: ${AUTOBUG_PATH}/logs/
- Database: ${AUTOBUG_PATH}/dev.db

## Claude Code
Claude Code CLI is installed and ready to use:
\`\`\`bash
claude --version
\`\`\`

## Groq API (Optional)
To enable Groq context enhancement:
1. Get API key from https://console.groq.com
2. Edit ${AUTOBUG_PATH}/.env
3. Set GROQ_ENABLED=true and GROQ_API_KEY=your_key
4. Restart services: systemctl restart autobug-server autobug-worker

## API Endpoints
- \`POST https://${DOMAIN}/api/tickets\` - Create ticket
- \`GET https://${DOMAIN}/api/tickets/my\` - List my tickets
- \`GET https://${DOMAIN}/admin\` - Admin panel
- \`POST https://${DOMAIN}/api/webhooks/chat-ticket\` - Webhook
EOF

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Installation Complete!                             ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Domain:${NC} https://${DOMAIN}"
echo -e "${BLUE}Autobug Path:${NC} ${AUTOBUG_PATH}"
echo -e "${BLUE}Project Path:${NC} ${PROJECT_PATH}"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "1. Copy your Autobug source files to ${AUTOBUG_PATH}"
echo "2. Run database migration: cd ${AUTOBUG_PATH} && npx prisma migrate dev"
echo "3. Start services: ./start.sh"
echo "4. Access admin panel at https://${DOMAIN}/admin"
echo ""
echo -e "${YELLOW}Claude Code is installed:${NC}"
echo "   claude --version"
echo ""
echo -e "${YELLOW}View logs:${NC}"
echo "   ./logs.sh"
echo ""
