#!/usr/bin/env bash
# =============================================================================
# NightCrawlers — EC2 / Ubuntu VM Deployment Script
# =============================================================================
# Run this ONCE on a fresh Ubuntu 22.04 server as root or sudo user.
# After this, CI/CD handles all future deployments automatically.
#
# Usage:
#   chmod +x deploy-setup.sh
#   sudo ./deploy-setup.sh
# =============================================================================

set -e  # Exit on any error

DOMAIN="api.nightcrawlers.com"
APP_DIR="/opt/nightcrawlers"
REPO="ghcr.io/YOUR_GITHUB_USERNAME/nightcrawlers"   # ← update this

echo "▶ [1/8] Updating system packages..."
apt-get update -y && apt-get upgrade -y

echo "▶ [2/8] Installing Docker..."
apt-get install -y ca-certificates curl gnupg lsb-release
mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

systemctl enable docker
systemctl start docker

echo "▶ [3/8] Installing Certbot (Let's Encrypt)..."
apt-get install -y certbot

echo "▶ [4/8] Creating app directory..."
mkdir -p $APP_DIR/nginx
cd $APP_DIR

echo "▶ [5/8] Copying config files..."
# You should scp these files to the server before running this script:
#   scp docker-compose.yml user@server:/opt/nightcrawlers/
#   scp nginx/nightcrawlers.conf user@server:/opt/nightcrawlers/nginx/
#   scp .env user@server:/opt/nightcrawlers/
echo "   → Make sure docker-compose.yml, nginx/nightcrawlers.conf and .env are in $APP_DIR"

echo "▶ [6/8] Setting up firewall (UFW)..."
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw --force enable

echo "▶ [7/8] Obtaining SSL certificate..."
# Stop anything on port 80 first
systemctl stop nginx 2>/dev/null || true
certbot certonly --standalone -d $DOMAIN \
  --non-interactive --agree-tos --email admin@nightcrawlers.com \
  --no-eff-email

# Auto-renew via cron
echo "0 3 * * * root certbot renew --quiet --post-hook 'docker compose -f $APP_DIR/docker-compose.yml restart nginx'" \
  > /etc/cron.d/certbot-renew

echo "▶ [8/8] Starting services..."
cd $APP_DIR
docker compose pull
docker compose up -d

echo ""
echo "✅ Deployment complete!"
echo "   API available at: https://$DOMAIN"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  GitHub Actions Secrets to add to your repo:"
echo "  DEPLOY_HOST     → $(curl -s ifconfig.me)"
echo "  DEPLOY_USER     → $(whoami)"
echo "  DEPLOY_SSH_KEY  → contents of your server's private key"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# =============================================================================
# ENVIRONMENT VARIABLES (.env on the server at /opt/nightcrawlers/.env)
# =============================================================================
# Copy this template and fill in your values:
#
# NODE_ENV=production
# PORT=5000
# MONGODB_URI=mongodb+srv://USER:PASS@cluster.mongodb.net/nightcrawlers
# JWT_SECRET=your_very_long_random_secret_here
# SMTP_HOST=smtp.gmail.com         # or Resend, SendGrid, etc.
# SMTP_PORT=465
# SMTP_USER=your@email.com
# SMTP_PASS=your_smtp_app_password
# SMTP_FROM=noreply@nightcrawlers.com
# FRONTEND_URL=https://night-crawlers.vercel.app
#
# =============================================================================
# USEFUL COMMANDS AFTER DEPLOYMENT
# =============================================================================
# View logs:          docker compose logs -f api
# Restart API:        docker compose restart api
# Pull & redeploy:    docker compose pull && docker compose up -d
# Check health:       docker compose ps
# Enter container:    docker compose exec api sh
# =============================================================================
