#!/usr/bin/env bash
# =============================================================================
# NightCrawlers — Safe Deploy Script
# =============================================================================
# Pulls new image, verifies health, swaps containers, snapshots + removes old.
# Automatically rolls back if the new container fails its health check.
#
# Place at: /opt/nightcrawlers/safe-deploy.sh
# Run:      chmod +x safe-deploy.sh
# =============================================================================

set -e

APP_DIR="/opt/nightcrawlers"
IMAGE="ghcr.io/nightcrawlers-app/nightcrawlersbackendv01:latest"
SERVICE="api"
HEALTH_URL="http://localhost:5000/"
MAX_HEALTH_RETRIES=10
HEALTH_RETRY_DELAY=3
SNAPSHOT_DIR="$APP_DIR/snapshots"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

cd "$APP_DIR"
mkdir -p "$SNAPSHOT_DIR"

echo "▶ [1/7] Recording current image digest (for rollback)..."
OLD_IMAGE_ID=$(docker compose images $SERVICE -q 2>/dev/null || echo "none")
echo "   Current image ID: $OLD_IMAGE_ID"

echo "▶ [2/7] Snapshotting current container state..."
if docker ps -a --format '{{.Names}}' | grep -q "nightcrawlers_${SERVICE}"; then
  docker commit "nightcrawlers_${SERVICE}" "nightcrawlers_${SERVICE}_snapshot_${TIMESTAMP}" > /dev/null
  echo "   Snapshot saved as: nightcrawlers_${SERVICE}_snapshot_${TIMESTAMP}"
  echo "$TIMESTAMP" > "$SNAPSHOT_DIR/last_snapshot.txt"
else
  echo "   No existing container — first deploy, skipping snapshot."
fi

echo "▶ [3/7] Pulling new image..."
docker pull "$IMAGE"

echo "▶ [4/7] Starting new container alongside old one (blue-green)..."
# Spin up new container on a temp port so we can test before swapping traffic
docker run -d \
  --name "nightcrawlers_${SERVICE}_new" \
  --network nightcrawlers_nightcrawlers_net \
  --env-file .env \
  -p 5001:5000 \
  "$IMAGE"

echo "▶ [5/7] Health-checking new container..."
HEALTHY=false
for i in $(seq 1 $MAX_HEALTH_RETRIES); do
  if curl -sf "http://localhost:5001/" > /dev/null 2>&1; then
    HEALTHY=true
    echo "   ✅ New container is healthy (attempt $i)"
    break
  fi
  echo "   ...waiting for health check (attempt $i/$MAX_HEALTH_RETRIES)"
  sleep $HEALTH_RETRY_DELAY
done

if [ "$HEALTHY" = false ]; then
  echo "❌ New container failed health check. Rolling back."
  docker logs "nightcrawlers_${SERVICE}_new" --tail 50
  docker stop "nightcrawlers_${SERVICE}_new" || true
  docker rm "nightcrawlers_${SERVICE}_new" || true
  echo "▶ Old container left untouched. Deploy aborted safely."
  exit 1
fi

echo "▶ [6/7] Swapping traffic to new container..."
docker stop "nightcrawlers_${SERVICE}_new" > /dev/null
docker rm "nightcrawlers_${SERVICE}_new" > /dev/null

# Now do the real swap via compose (this recreates with the pulled image)
docker compose up -d --no-deps --force-recreate "$SERVICE"

# Final confirmation health check on the real container/port
sleep 5
if ! curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  echo "❌ Production swap failed health check after compose recreate!"
  echo "   Attempting automatic rollback to previous image..."
  if [ "$OLD_IMAGE_ID" != "none" ] && [ -n "$OLD_IMAGE_ID" ]; then
    docker tag "$OLD_IMAGE_ID" "$IMAGE"
    docker compose up -d --no-deps --force-recreate "$SERVICE"
    echo "   Rolled back to previous image: $OLD_IMAGE_ID"
  else
    echo "   ⚠ No old image ID available — manual intervention required."
  fi
  exit 1
fi

echo "▶ [7/7] Cleaning up..."
# Keep only the last 3 snapshots to avoid disk bloat
SNAPSHOT_COUNT=$(docker images --format '{{.Repository}}' | grep "nightcrawlers_${SERVICE}_snapshot_" | wc -l)
if [ "$SNAPSHOT_COUNT" -gt 3 ]; then
  docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
    | grep "nightcrawlers_${SERVICE}_snapshot_" \
    | sort -k2 \
    | head -n -3 \
    | awk '{print $1}' \
    | xargs -r docker rmi -f
  echo "   Pruned old snapshots, keeping last 3."
fi

# Remove dangling/unused images (the genuinely old, now-unreferenced layers)
docker image prune -f

echo ""
echo "✅ Deploy complete and verified healthy."
echo "   Image: $IMAGE"
echo "   Snapshot saved: nightcrawlers_${SERVICE}_snapshot_${TIMESTAMP}"
echo "   (To roll back manually: docker tag nightcrawlers_${SERVICE}_snapshot_${TIMESTAMP} $IMAGE && docker compose up -d --force-recreate $SERVICE)"
