# signoz

A tri-colour Package Skill (green, red, blue) that provisions a **single-node
SigNoz observability stack** on one VM through the colors-compute library:
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
| Compute | One library-owned node, ingress policy and managed SSH key registration; provider selection and remote state belong to colors-compute |
| DNS | One proxied Cloudflare `A` record for `signoz-host` |
| Server | Docker Compose: ClickHouse, ClickHouse Keeper, Postgres, the migrator, SigNoz, the ingester, Caddy |

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
External account key references require `ssh-private-key-path`; external
private keys are never generated or removed. The local SSH block writes
`IdentityFile` only for a managed deployment key.

Existing `<profile>/signoz-infrastructure.tfstate` is refused before
compute mutation. Do not remove it to bypass this check: migrate ownership
explicitly or destroy the old deployment through its original version first.
Unreadable state and provider mismatches fail closed.

The default adapter remains `vultr`. SigNoz requests TCP 22, 80 and 443;
4317 and 4318 remain closed. Ingestion uses Caddy and its bearer-token gate.

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
