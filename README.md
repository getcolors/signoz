# signoz

A tri-colour Package Skill (green, red, blue) that provisions a **single-node
SigNoz observability stack** on one Vultr instance or one DigitalOcean droplet:
ClickHouse and ClickHouse Keeper, a Postgres metastore, the schema migrator,
the SigNoz application, the `signoz-otel-collector` ingester, and Caddy
terminating TLS.

One public host carries both halves. Caddy serves the SigNoz UI and proxies
OTLP/HTTP on `/v1/{logs,traces,metrics}` to the collector, so an exporter needs
only `https://<signoz-host>` — plus a bearer token, because SigNoz community
edition has no ingestion keys of its own and an unguarded collector would be an
open write path into ClickHouse.

## Install

```sh
npx skills add getcolors/signoz
cp .agents/skills/package-signoz-green/green ./green
chmod +x green
```

The launcher in your project root is a **copy**, not a symlink. After
`npx skills update -p`, copy it again or the project keeps running the old pin.

The same deployment can run through the TypeScript (`package-signoz-red`) or
Python (`package-signoz-blue`) implementation — all three render byte-identical
artifacts from one `colors.yml`.

## Use

```sh
./green build              # render .colors/<profile>/ — contacts nothing
./green create --dry-run   # walk the workflow, skip every side effect
./green create             # converge for real
./green delete             # guarded; see below
```

`build` and `--dry-run` work on a fresh checkout with an empty environment,
which makes them the safe way to check a `colors.yml` edit. Exit code 2 means
validation failure and lists every problem at once.

## Architecture

| Layer | Contents |
|---|---|
| Compute | One Vultr instance or one DigitalOcean droplet (`provider-compute`), a provider firewall opening 22/80/443, and — in keygen mode — the account SSH key named after the profile. On DigitalOcean the droplet joins the region's default VPC, discovered at plan time |
| DNS | One proxied Cloudflare `A` record for `signoz-host` |
| Server | Docker Compose: ClickHouse, ClickHouse Keeper, Postgres, the migrator, SigNoz, the ingester, Caddy |

## Two compute providers

`provider-compute` selects `vultr` or `digitalocean`. Each provider is a
template directory of its own, with its own credential and its own
provider-scoped keys (`vultr-region`, `vultr-plan`, `vultr-os-id`;
`digitalocean-region`, `digitalocean-size`, `digitalocean-image`; and
`<provider>-ssh-sources` / `<provider>-http-sources` on both). Keys of the
unselected provider are ignored, so one `colors.yml` can carry both.
`<provider>-name` is optional and defaults to the profile, and keygen mode —
no `<provider>-ssh-keys` — works on both providers.

Switching providers is a rebuild, never an apply: a profile whose state already
holds a machine refuses a create or delete under a different `provider-compute`
until it is set back and deleted.

## Configuration

`colors.yml` is the only file you edit; see
`skills/package-signoz-green/references/configuration.md` for every key.
Credentials are `COLORS_PAR_*` environment variables in a gitignored
`.envrc.private`:

| Variable | For |
|---|---|
| `COLORS_PAR_VULTR_API_KEY` | compute, with `provider-compute: vultr` |
| `COLORS_PAR_DO_TOKEN` | compute, with `provider-compute: digitalocean` |
| `COLORS_PAR_CLOUDFLARE_API_TOKEN` | DNS, with edit rights on the zone |
| `COLORS_PAR_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | OpenTofu state |
| `COLORS_PAR_SIGNOZ_BACKUP_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | metastore backups |
| `COLORS_PAR_SIGNOZ_ROOT_PASSWORD` | the SigNoz root account |

Never export `COLORS_PAR_PROFILE`: the profile keys remote state, and
overlaying it points one deployment at another's.

## After a create

The UI is at `https://<signoz-host>`, and you sign in as
`signoz-root-email` with `COLORS_PAR_SIGNOZ_ROOT_PASSWORD`. Root provisioning
runs at application startup only, and the root account cannot be edited or
deleted from the UI — changing the password means changing that variable and
recreating the container.

The ingestion token is generated on the server. Read it with:

```sh
ssh <profile> cat /etc/signoz/ingestion.env
```

Point an exporter at the host with an `Authorization: Bearer <token>` header:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://<signoz-host>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<token>
```

Only OTLP/HTTP is published. gRPC on 4317 stays on loopback.

## Recovery

A daily systemd timer dumps the Postgres metastore — users, dashboards, alert
rules, saved views — to Cloudflare R2 under `<bucket>/<profile>/`. The
telemetry databases are deliberately **not** backed up: they are regenerable,
they age out on their own retention, and a hot copy races ClickHouse's merges.

Restoring is `./green create` for the infrastructure plus the dump for the
metastore:

```sh
rclone copy r2:<bucket>/<profile>/metastore-<stamp>.sql.gz .
gunzip -c metastore-<stamp>.sql.gz | \
  ssh <profile> docker compose -f /opt/signoz/compose.yml exec -T metastore \
    psql -U signoz -d signoz
```

Run `/usr/local/sbin/signoz-backup` on the host to take one immediately.

## Upstream

SigNoz deprecated its Docker Compose manifests in favour of the Foundry CLI.
This package deliberately does not run Foundry — `colors.yml` → `.colors/` is
already this workspace's declarative pipeline — and instead maintains templates
derived from Foundry's reference pour. Re-read that pour when bumping the
application or collector image; nothing here follows upstream automatically.

## Development

```sh
cd green && bb test    # unit tests (canonical Clojure implementation)
cd green && bb golden  # render all four fixtures (two providers × two SSH modes), diff against committed output
cd green && bb golden:accept  # after an intended change — read the diff first
cd red && bun test && bun run typecheck   # TypeScript implementation
cd blue && uv run pytest                  # Python implementation
./scripts/parity.sh    # all three colours render byte-identical trees, both providers
./scripts/launcher.sh  # the payload launcher, end to end
```

`SIGNOZ_LIB_ROOT`, `GREEN_LIB_ROOT` and `ONCE_LIB_ROOT` point the launchers at
working trees instead of pinned SHAs.
