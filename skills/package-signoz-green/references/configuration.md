# Configuration

Every key `colors.yml` may carry, and every credential the package reads.
Non-secret values only: credentials are `COLORS_PAR_*` environment variables.

## Identity and providers

| Key | Meaning |
|---|---|
| `profile` | Names the work directory, the OpenTofu state key (`<profile>/<stage>.tfstate`), the machine keypair, the `~/.ssh/config` alias and the Vultr key resource. Never overlay it from the environment. |
| `workdir` | Where rendered output goes. Conventionally `.colors`. |
| `provider-compute` | Must be `vultr`. |
| `provider-dns` | Must be `cloudflare`. |
| `provider-backend` | `local`, `s3` or `r2`. |
| `compute-prevent-destroy` | Keep `true` in committed desired state. |

## SigNoz

| Key | Meaning |
|---|---|
| `signoz-host` | Public hostname. Caddy serves the UI here and proxies OTLP under the same host; its registrable domain must be a Cloudflare zone your token can edit. |
| `signoz-root-email` | The root account SigNoz provisions at startup. Its password is `COLORS_PAR_SIGNOZ_ROOT_PASSWORD`. |
| `signoz-root-org-name` | Organization name for that account. On an existing deployment it must match what is already in the metastore, or provisioning fails rather than renaming. |
| `signoz-image` | The SigNoz application. |
| `signoz-collector-image` | The `signoz-otel-collector`, used for both the ingester and the migrator. |
| `signoz-clickhouse-image` | ClickHouse server, also used by the `user-scripts` init container. |
| `signoz-clickhouse-keeper-image` | ClickHouse Keeper. Upstream replaced ZooKeeper with Keeper; guides that describe a `signoz/zookeeper` container are stale. |
| `signoz-postgres-image` | The metastore. |
| `signoz-caddy-image` | The reverse proxy. |
| `signoz-histogram-quantile-version` | Release tag of the `histogramQuantile` binary fetched from GitHub releases. |
| `signoz-ingestion-token-file` | Absolute path on the server holding the generated bearer token. |

The application and the collector **version independently** upstream, and the
collector owns the ClickHouse schema the application queries. Use the pair
SigNoz's own Helm chart ships together, and move them together. Validation
rejects a floating `:latest` or `:main` on either.

## Backups

The Postgres metastore only — users, dashboards, alert rules, saved views. The
telemetry databases are excluded on purpose: regenerable, TTL'd, and a hot copy
races ClickHouse's merges.

| Key | Meaning |
|---|---|
| `signoz-backup-dir` | Absolute path on the server for local dumps before upload. |
| `signoz-backup-r2-bucket` | Existing R2 bucket. The deployment owns only its `<profile>/` prefix. |
| `signoz-backup-r2-endpoint` | R2 S3 endpoint. |
| `signoz-backup-r2-region` | Conventionally `auto`. |
| `signoz-backup-oncalendar` | systemd `OnCalendar` expression for the timer. |
| `signoz-backup-retention-days` | Positive integer. Applied inside the deployment's own prefix and nowhere else. |

## Vultr

| Key | Meaning |
|---|---|
| `vultr-name` | Console label. Updates in place — unlike a hostname, which Vultr implements as an OS reinstall. |
| `vultr-region` | e.g. `ams`. |
| `vultr-plan` | `vc2-4c-8gb` is the realistic floor: upstream states a 4 GiB minimum for Docker alone, and ClickHouse, Keeper, Postgres, the collector and the application are colocated. |
| `vultr-os-id` | Numeric OS id; `2284` is Ubuntu 24.04 LTS x64. |
| `vultr-ssh-keys` | **Omit for keygen mode**, where the package generates and owns `~/.ssh/<profile>`. Supplying an existing key id switches to opt-out mode, where the package touches no key material at all. |
| `vultr-ssh-sources` | CIDRs allowed to reach 22. |
| `vultr-http-sources` | CIDRs allowed to reach 80 and 443. |

4317 and 4318 are never opened: ingestion arrives through Caddy on 443.

## State backend

| Key | Meaning |
|---|---|
| `r2-bucket` | Bucket holding `<profile>/<stage>.tfstate`. |
| `r2-endpoint` | R2 S3 endpoint. |

## Credentials

| Variable | Needed by |
|---|---|
| `COLORS_PAR_VULTR_API_KEY` | any real event |
| `COLORS_PAR_CLOUDFLARE_API_TOKEN` | any real event; edit rights on the zone |
| `COLORS_PAR_R2_ACCESS_KEY_ID` / `COLORS_PAR_R2_SECRET_ACCESS_KEY` | the state backend |
| `COLORS_PAR_SIGNOZ_ROOT_PASSWORD` | `create` only |
| `COLORS_PAR_SIGNOZ_BACKUP_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | `create` only |

A `delete` asks for the provider and backend credentials alone. Requiring the
application secrets to destroy a machine would only be a lock on the exit.

Two secrets are **generated on the server** and are never supplied: the OTLP
ingestion bearer token and the Postgres password. Neither reaches `colors.yml`,
`.colors/`, a golden, or `.envrc.private`.
