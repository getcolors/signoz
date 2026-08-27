#!/usr/bin/env bash
# End-to-end ingest proof, run on the server during convergence.
#
# It sends one OTLP/HTTP log record through the *public* path — Caddy, the
# bearer-token gate, the collector — and then waits for the row to appear in
# ClickHouse. A pass therefore means TLS, routing, authorization, the receiver,
# the exporter and the schema all work. Anything less than that has repeatedly
# looked like success while storing nothing.
#
# `--resolve` pins the hostname to loopback so the check exercises this host's
# own Caddy rather than a round trip through Cloudflare, while still presenting
# the real certificate and the real server name.
set -euo pipefail

. <{ signoz-ingestion-token-file }>

host="<{ signoz-host }>"
compose="docker compose -f /opt/signoz/compose.yml"
marker="signoz create-time acceptance smoke $(date +%s)"
now_ns="$(date +%s)000000000"

payload=$(cat <<JSON
{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"signoz-smoke"}}]},
"scopeLogs":[{"logRecords":[{"timeUnixNano":"$now_ns","severityText":"INFO",
"body":{"stringValue":"$marker"}}]}]}]}
JSON
)

# The gate must refuse an unauthenticated write before we prove an authorized
# one works. An endpoint that accepts both is an open write path, and that is
# indistinguishable from success unless it is checked.
unauth=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$host:443:127.0.0.1" \
  -X POST -H 'content-type: application/json' \
  --data "$payload" "https://$host/v1/logs")
if [ "$unauth" != "401" ]; then
  echo "signoz-smoke: unauthenticated ingestion returned $unauth, expected 401" >&2
  exit 1
fi

curl -fsS --resolve "$host:443:127.0.0.1" \
  -X POST -H 'content-type: application/json' \
  -H "authorization: Bearer $SIGNOZ_INGEST_TOKEN" \
  --data "$payload" "https://$host/v1/logs" >/dev/null

# The exporter batches, so the row is not instantaneous. The table name differs
# between SigNoz schema generations; ask the server which one exists rather
# than hardcoding a guess that fails silently as an empty count.
table=$($compose exec -T telemetrystore clickhouse-client --query \
  "SELECT name FROM system.tables WHERE database = 'signoz_logs'
     AND name IN ('distributed_logs_v2','logs_v2')
   ORDER BY name = 'distributed_logs_v2' DESC LIMIT 1" 2>/dev/null | tr -d '[:space:]' || true)

if [ -z "${table:-}" ]; then
  echo "signoz-smoke: no logs table exists in signoz_logs; the migrator did not build the schema" >&2
  exit 1
fi

for _ in $(seq 1 30); do
  count=$($compose exec -T telemetrystore clickhouse-client --query \
            "SELECT count() FROM signoz_logs.$table WHERE body = '$marker'" \
            2>/dev/null | tr -d '[:space:]' || true)
  if [ -n "${count:-}" ] && [ "$count" -gt 0 ] 2>/dev/null; then
    echo "signoz smoke: $count row(s) reached signoz_logs.$table"
    exit 0
  fi
  sleep 5
done

echo "signoz-smoke: no row reached signoz_logs.$table for this run" >&2
exit 1
