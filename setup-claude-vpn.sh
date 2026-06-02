#!/bin/bash
#
# Setup Claude Code on VPN Server with User's Credentials
# Run this after deployment to authenticate Claude Code
#

SERVER="156.67.105.64"
USER="root"
PASSWORD="30rZNitUz*un6vgz"

echo "=========================================="
echo "Claude Code Setup on VPN Server"
echo "=========================================="
echo ""

# Check if sshpass is available
if ! command -v sshpass &> /dev/null; then
    echo "Error: sshpass is required. Install with: brew install sshpass"
    exit 1
fi

echo "Connecting to VPN server..."
echo ""
echo "You have two options to authenticate Claude Code:"
echo ""
echo "OPTION 1: Web Authentication (Recommended)"
echo "  1. SSH to server: ssh root@$SERVER"
echo "  2. Run: claude auth login"
echo "  3. Open the provided URL in your browser"
echo "  4. Authenticate with your Anthropic account"
echo ""
echo "OPTION 2: API Key"
echo "  If you have an API key, we can configure it directly"
echo ""

read -p "Do you want to authenticate now via SSH? (y/n): " choice

if [ "$choice" = "y" ] || [ "$choice" = "Y" ]; then
    echo ""
    echo "Opening SSH session. Run these commands:"
    echo "  1. claude auth login"
    echo "  2. Follow the browser link"
    echo "  3. After authentication, run: claude --version"
    echo "  4. Exit SSH with: exit"
    echo ""
    read -p "Press Enter to continue..."

    # Open interactive SSH session
    sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no root@$SERVER

    echo ""
    echo "=========================================="
    echo "Verifying Claude Code installation..."
    echo "=========================================="

    # Check if Claude is now authenticated
    CLAUDE_VERSION=$(sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no root@$SERVER "claude --version 2>&1" | grep -v "Warning:" || true)
    echo "Claude Code: $CLAUDE_VERSION"

    echo ""
    echo "✅ Setup complete!"
    echo ""
    echo "Test Claude Code:"
    echo "  ssh root@$SERVER"
    echo "  cd /var/www/adelphos_frontend"
    echo "  claude 'Check the codebase structure'"
fi

echo ""
echo "=========================================="
echo "Alternative: Configure via API Key"
echo "=========================================="
echo ""
echo "If you have an Anthropic API key, you can set it directly:"
echo ""
echo "  export ANTHROPIC_API_KEY='your-api-key-here'"
echo "  claude --version"
echo ""
echo "Or add to /opt/autobug/.env on the server"
echo ""
