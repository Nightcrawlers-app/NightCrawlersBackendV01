#!/usr/bin/env bash
# =============================================================================
# NightCrawlers — "why does the API keep dropping?" check-up
# =============================================================================
# Run on the VM:   cd /opt/nightcrawlers && bash diagnose.sh
# Then copy everything it prints and share it. It prints NO secrets.
# =============================================================================

DOMAIN="${1:-api.nightcrawlers.app}"
line() { printf '\n━━━ %s ━━━\n' "$1"; }

line "1. Containers (look for Restarting, Exited, or a high restart count)"
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>&1
for c in $(docker ps -a --format '{{.Names}}' | grep nightcrawlers); do
  printf '%-28s restarts=%s  oom_killed=%s  exit_code=%s  started=%s\n' "$c" \
    "$(docker inspect -f '{{.RestartCount}}' "$c")" \
    "$(docker inspect -f '{{.State.OOMKilled}}' "$c")" \
    "$(docker inspect -f '{{.State.ExitCode}}' "$c")" \
    "$(docker inspect -f '{{.State.StartedAt}}' "$c")"
done

line "2. Memory and swap (low 'available' + no swap = the kernel kills containers)"
free -h
echo; echo "Kernel out-of-memory kills (most recent last):"
(sudo dmesg -T 2>/dev/null || dmesg -T 2>/dev/null) | grep -iE 'out of memory|oom-kill|killed process' | tail -10 || true

line "3. Disk (a full disk stops Docker and MongoDB drivers from writing)"
df -h / /var/lib/docker 2>/dev/null
echo; docker system df 2>/dev/null

line "4. API log — last 80 lines (crashes, Mongo errors, 'We are live' restarts)"
docker logs nightcrawlers_api --tail 80 2>&1

line "5. Crash / database lines in the last 24h"
docker logs nightcrawlers_api --since 24h 2>&1 | grep -iE 'error|unhandled|uncaught|mongo|ECONN|ETIMEDOUT|heap|killed|We are live' | tail -40

line "6. nginx errors (upstream = the API wasn't reachable from nginx)"
docker logs nightcrawlers_nginx --since 24h 2>&1 | grep -iE 'error|upstream|limiting|emerg' | tail -30

line "7. Health checks"
echo -n "API directly (localhost:5000/health): "; curl -s -m 5 -o /dev/null -w '%{http_code} in %{time_total}s\n' http://localhost:5000/health || echo "NO RESPONSE"
echo -n "Through nginx + HTTPS (https://$DOMAIN/health): "; curl -s -m 10 -o /dev/null -w '%{http_code} in %{time_total}s\n' "https://$DOMAIN/health" || echo "NO RESPONSE"
echo -n "What nginx thinks the API's address is vs the real one: "
echo "nginx → $(docker exec nightcrawlers_nginx getent hosts nightcrawlers_api 2>/dev/null | awk '{print $1}')  real → $(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' nightcrawlers_api 2>/dev/null)"

line "8. SSL certificate (expired = every browser request fails)"
echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -subject -dates 2>/dev/null || echo "Could not read the certificate"
sudo certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains|Expiry' || true

line "9. MongoDB Atlas reachable from this VM? (Atlas blocks IPs not on its allow list)"
echo "This VM's public IP: $(curl -s -m 5 ifconfig.me)  ← must be in Atlas → Network Access"
docker exec nightcrawlers_api node -e "
  require('mongoose').connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:8000})
  .then(()=>{console.log('Atlas: connected OK');process.exit(0)})
  .catch(e=>{console.log('Atlas: FAILED —',e.message);process.exit(1)})" 2>&1 | tail -2

line "10. Machine"
echo "CPUs: $(nproc)   Uptime: $(uptime -p)"
cat /etc/os-release 2>/dev/null | grep PRETTY_NAME
curl -s -m 3 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/machine-type 2>/dev/null | awk -F/ '{print "GCP machine type:", $NF}'
echo
echo "Done. Copy everything above and share it."
