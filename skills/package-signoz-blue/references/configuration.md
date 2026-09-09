# Configuration

Every key `colors.yml` may carry, and every credential the package reads.
Non-secret values only: credentials are `COLORS_PAR_*` environment variables.

## Identity and providers

| Key | Meaning |
|---|---|
| `profile` | Names the work directory, the OpenTofu state key (`<profile>/<stage>.tfstate`), the machine keypair, the `~/.ssh/config` alias, the machine itself and the provider key resource. Never overlay it from the environment. |
| `workdir` | Where rendered output goes. Conventionally `.colors`. |
| `provider-compute` | Adapter selected from the colors-compute library; default `vultr`. The library validates its inputs and refuses an identity change while resources remain owned. |
| `provider-dns` | Must be `cloudflare`. |
| `provider-backend` | `s3` or `r2`; remote state is required. |
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

## Compute ownership

The pinned `colors-compute` library owns provider selection, remote S3/R2
state, deployment coordination, machine keys, network policy and the single
node. This package supplies singleton topology and SSH/HTTP ingress, then
uses the returned address, login user and SSH identity for its application
steps. New provider support belongs in the library; consumers update its pin.
The application needs a supported Ubuntu image and sufficient memory for
SigNoz, ClickHouse, Keeper, Postgres and the collector. Build first to check adapter capabilities.

Use `signoz-ssh-sources` and `signoz-http-sources` for neutral CIDR
allowlists. Existing selected-provider source options remain compatible.
External account key references may use `ssh-private-key-path` or operator/agent SSH configuration; external
private keys are never generated or removed. The local SSH block writes
`IdentityFile` only for a managed deployment key.

Existing `<profile>/signoz-infrastructure.tfstate` is refused before
compute mutation. Do not remove it to bypass this check: migrate ownership
explicitly or destroy the old deployment through its original version first.
Unreadable state and provider mismatches fail closed.

The default adapter remains `vultr`. SigNoz requests TCP 22, 80 and 443;
4317 and 4318 remain closed. Ingestion uses Caddy and its bearer-token gate.

No private network is requested by default. Explicit supported references,
including `digitalocean-vpc-uuid`, are discovered and validated by the library
without taking ownership of the existing network. Image, region and size
options remain adapter-specific library inputs; use a supported Ubuntu image
and adequate memory for the colocated services.

A managed machine key is generated at `~/.ssh/<profile>` only on a real create,
with journal ownership recorded first. External key references may use `ssh-private-key-path` or operator/agent SSH configuration and are never generated or deleted. The local
SSH stage locks and atomically updates `Host <profile>` using the observed IP
and login user; only managed keys produce `IdentityFile`/`IdentitiesOnly`.
Conflicting unmanaged stanzas or leading global options refuse the update.

## State backend

| Key | Meaning |
|---|---|
| `r2-bucket` | Bucket holding `<profile>/compute/shared.tfstate`, per-node states, and separate application-stage states. |
| `r2-endpoint` | R2 S3 endpoint. |

S3 uses `s3-bucket`, `s3-region` and the ambient AWS credential chain; R2 uses
the two backend credentials below. Other compute adapters and their required
credentials are defined only in the library.

## Credentials

| Variable | Needed by |
|---|---|
| `COLORS_PAR_VULTR_API_KEY` | any real event with `provider-compute: vultr` |
| `COLORS_PAR_DO_TOKEN` | any real event with `provider-compute: digitalocean` |
| `COLORS_PAR_CLOUDFLARE_API_TOKEN` | any real event; edit rights on the zone |
| `COLORS_PAR_R2_ACCESS_KEY_ID` / `COLORS_PAR_R2_SECRET_ACCESS_KEY` | the state backend |
| `COLORS_PAR_SIGNOZ_ROOT_PASSWORD` | `create` only |
| `COLORS_PAR_SIGNOZ_BACKUP_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | `create` only |

A `delete` asks for the provider and backend credentials alone. Requiring the
application secrets to destroy a machine would only be a lock on the exit.
Only the selected compute provider's credential is required; the other is
ignored.

Two secrets are **generated on the server** and are never supplied: the OTLP
ingestion bearer token and the Postgres password. Neither reaches `colors.yml`,
`.colors/`, a golden, or `.envrc.private`.

## Failure modes

| Symptom | Meaning | Recovery |
|---|---|---|
| `container signoz-signoz-1 is unhealthy`, and the application logs `migrate: migrations table is already locked` (`duplicate key value violates unique constraint "migration_lock_table_name_key"`) | bun-migrate takes a **row** in the metastore's `migration_lock` table during startup migrations, not an advisory lock. An application container killed mid-migration leaves the row behind and every later start times out on it. | Safe only when no application container is running: `ssh <profile>`, then in `/opt/signoz` run `docker compose stop signoz && docker compose exec -T metastore psql -U signoz -d signoz -c 'delete from migration_lock'`, then re-converge with `create`. |
| `state holds a … machine; set provider-compute back` | `provider-compute` was changed on a profile with a live machine | Set it back, `delete`, then switch and `create` |
| Compute state could not be read | The backend is unreadable on a real delete | Fix the backend credentials; a delete never proceeds against an address it cannot read |
| `compute node unavailable` | A real create's compute stage applied without an address | Inspect the compute state; the converge refuses the documentation address rather than target it |

Legacy `<profile>/signoz-infrastructure.tfstate` requires explicit migration
or destruction with the original version before this library can create resources.
Never erase state to bypass that guard.
