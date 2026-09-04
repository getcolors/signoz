# Configuration

Every key `colors.yml` may carry, and every credential the package reads.
Non-secret values only: credentials are `COLORS_PAR_*` environment variables.

## Identity and providers

| Key | Meaning |
|---|---|
| `profile` | Names the work directory, the OpenTofu state key (`<profile>/<stage>.tfstate`), the machine keypair, the `~/.ssh/config` alias, the machine itself and the provider key resource. Never overlay it from the environment. |
| `workdir` | Where rendered output goes. Conventionally `.colors`. |
| `provider-compute` | `vultr` or `digitalocean`. Selects the compute template and which provider-scoped keys below are read; the other provider's keys are ignored. Switching on a profile that already holds a machine is refused — see below. |
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

## Vultr (`provider-compute: vultr`)

| Key | Meaning |
|---|---|
| `vultr-name` | Optional console label; defaults to the profile. Letters, digits, `.`, `_`, `-` (1-63 characters). Updates in place — unlike a hostname, which Vultr implements as an OS reinstall. |
| `vultr-region` | e.g. `ams`. |
| `vultr-plan` | `vc2-4c-8gb` is the realistic floor: upstream states a 4 GiB minimum for Docker alone, and ClickHouse, Keeper, Postgres, the collector and the application are colocated. |
| `vultr-os-id` | Numeric OS id; `2284` is Ubuntu 24.04 LTS x64. |
| `vultr-ssh-keys` | **Omit for keygen mode**, where the package generates and owns `~/.ssh/<profile>`. Supplying an existing key id switches to opt-out mode, where the package touches no key material at all. |
| `vultr-ssh-sources` | CIDRs allowed to reach 22. |
| `vultr-http-sources` | CIDRs allowed to reach 80 and 443. |

## DigitalOcean (`provider-compute: digitalocean`)

| Key | Meaning |
|---|---|
| `digitalocean-name` | Optional droplet name; defaults to the profile. Hostname-like (lowercase letters, digits, dots, hyphens; 1-63 characters), checked before any provider call. Renames in place, but the guest hostname cloud-init set at creation lags until a rebuild. |
| `digitalocean-region` | e.g. `ams3`. ForceNew. |
| `digitalocean-size` | `s-4vcpu-8gb` is the realistic floor, for the same colocation reason as the Vultr plan. Resizes in place. |
| `digitalocean-image` | Droplet image slug, e.g. `ubuntu-24-04-x64`. ForceNew. |
| `digitalocean-ssh-keys` | **Omit for keygen mode**, exactly as with `vultr-ssh-keys`. Supplying an existing account key id or fingerprint opts out. |
| `digitalocean-ssh-sources` | CIDRs allowed to reach 22. |
| `digitalocean-http-sources` | CIDRs allowed to reach 80 and 443. |

The droplet joins the region's default VPC (`default-<region>`), discovered at
plan time. `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr` are refused:
this package neither pins nor creates a VPC.

## The firewall sources

The provider firewall is the load-bearing layer on both providers — inbound 22
from `<provider>-ssh-sources`, 80 and 443 from `<provider>-http-sources`,
nothing else; Ansible manages no host firewall for these ports. Every entry
must be a syntactically valid IPv4 or IPv6 CIDR and the SSH list must not be
empty, both checked before any provider call. An empty HTTP list is allowed
and means no public HTTP.

4317 and 4318 are never opened on either provider: ingestion arrives through
Caddy on 443, behind the bearer token.

## Switching providers

Provider switching is a rebuild, never an apply. Both providers share one
state key, so a changed `provider-compute` on a profile whose state already
holds a machine is refused on create *and* delete with
`state holds a <recorded> machine; set provider-compute back to <recorded> and
delete first`. A deployment created before this package recorded the provider
in its compute output is treated as Vultr. The check reads the state with the
backend credentials alone and runs before the provider credential check, so a
mistaken edit reports the actionable error rather than a missing token. On a
real delete an unreadable backend is an error, never an empty state, and a
real create whose compute stage produced no address refuses to converge
against the documentation address.

## State backend

| Key | Meaning |
|---|---|
| `r2-bucket` | Bucket holding `<profile>/<stage>.tfstate`. |
| `r2-endpoint` | R2 S3 endpoint. |

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
| `could not read the infrastructure state for the delete cleanup` | The backend is unreadable on a real delete | Fix the backend credentials; a delete never proceeds against an address it cannot read |
| `compute produced no ip output` | A real create's compute stage applied without an address | Inspect the compute state; the converge refuses the documentation address rather than target it |
