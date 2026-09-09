# CLAUDE.md

## Repository

`signoz` is a tri-colour Package Skill (green, red, blue) for a single-node
SigNoz observability stack on one VM through the shared colors-compute library.
OpenTofu manages the machine, a provider firewall (22/80/443), and a proxied
Cloudflare A record; Ansible converges a Docker
Compose stack of ClickHouse, ClickHouse Keeper, a Postgres metastore, the
schema migrator, the SigNoz application, the signoz-otel-collector ingester,
and Caddy. The first consumer is `../signoz-vultr`.

One public host carries both halves: Caddy serves the SigNoz UI and proxies
OTLP/HTTP on the standard `/v1/{logs,traces,metrics}` paths to the collector,
so an exporter needs only `https://<signoz-host>` plus a bearer token. Every
other port is bound to loopback, which is why the firewall opens only 80/443
and never 4317/4318.

## Shared compute ownership

All three colors depend on `colors-compute`, currently pinned to `422c3f39d22be93efa703da09eb192490942ede3`.
Read `../workspace/standards/compute-provider.md`, `compute-name.md` and
`compute-cluster.md` before changing this boundary. This package owns only
application requirements and singleton topology: role null, count 1. Its
`compute` module delegates to library `plan_deployment`, `orchestrate` and
`read_deployment`; do not add a provider registry, provider dispatch, compute
OpenTofu templates, backend implementation, state writer or key lifecycle here.
A newly supported provider requires only a library dependency update in consumers.
The default remains `vultr`; provider capabilities and option validation
are defined by the library. Neutral `signoz-ssh-sources` and
`signoz-http-sources` are accepted alongside the selected adapter's legacy keys.

Build writes library documents under `compute/shared` and `compute/nodes/0`.
Each stage receives the library `backend_plan` configuration. Remote state keys
are `<profile>/compute/shared.tfstate` and `<profile>/compute/nodes/0.tfstate`;
S3 uses ambient AWS credentials, R2 binds its explicit backend credentials in
private configuration. The deployment journal serializes mutations. Compute
credential checks occur inside the library after ownership/state inspection.
DNS remains an application stage with its separate `<profile>/signoz-dns.tfstate`.

The library refuses existing `<profile>/signoz-infrastructure.tfstate` before
mutation. That old monolithic state needs explicit ownership migration or
teardown using the original package version. Never delete a state object to
bypass this refusal. Unreadable state, identity mismatches, ambiguous resource
ownership and live results without an address fail closed. Build-only planned
addresses must never become fallback targets for create/delete.

The joined node supplies the address, login user, provider identity and SSH
identity for downstream application steps. Do not assume the user is root.
No private network is requested by default. Explicit network references and
adapter capabilities are library concerns. The ingress policy is TCP22/80/443;
empty HTTP sources close HTTP ingress.

## Why this package does not run Foundry

Upstream deprecated its `install.sh` and its Docker Compose manifests in favour
of **Foundry** (`foundryctl`), a CLI that renders a `casting.yaml` into a
generated compose tree under `pours/` alongside a `casting.yaml.lock`.

That is the same shape as `colors.yml` → `.colors/`, and running both would
mean two declarative configs, two generators and two lockfiles for one
deployment — with the authoritative one being whichever ran last. So the
templates here are derived from Foundry's own reference pour
(`SigNoz/foundry:docs/examples/docker/compose/pours/deployment/`) and
maintained as this package's own, with image tags lifted into desired state and
the service hostnames shortened. Every DSN is explicit, so the renaming changes
nothing the images infer.

The cost is real and was accepted deliberately: when upstream changes the pour,
nothing here follows automatically. Re-read the reference pour when bumping
`signoz-image` or `signoz-collector-image`.

## Why the ingestion token exists

SigNoz community edition has **no ingestion keys** — they are a SigNoz Cloud
feature. The collector accepts OTLP from anyone who can reach it, so publishing
`/v1/*` unguarded would be an open write path into ClickHouse. Caddy therefore
admits those paths only with a bearer token generated on the server.

The token is this package's own mechanism, not an upstream one. Two
consequences follow. Caddy resolves it as `{$SIGNOZ_INGEST_TOKEN}` at config
load, and an unset variable becomes the empty string — which would match a bare
`Authorization: Bearer `. The playbook asserts the token file is non-empty
before converging, and that assertion is the difference between a gate and an
open door. And because it is not upstream's mechanism, an upstream auth feature
later may not compose with it.

## What fails silently here

Convergence asks components what they actually have, rather than trusting exit
codes, because each of these has been observed to look like success:

- the migrator can exit zero without the `signoz_traces`/`signoz_logs`/
  `signoz_metrics` databases existing, so the play counts them;
- the `user-scripts` init container fetches `histogramQuantile` from GitHub
  releases and is `restart: on-failure`; a failed fetch leaves every container
  healthy and only removes quantile queries, so the play asserts the function
  is in `system.functions`;
- an OTLP endpoint answers 200 whether or not a row is ever stored, so
  `signoz-smoke` sends a record through the public path — TLS, Caddy, the token
  gate, the collector — and waits for it in ClickHouse.

## The migration lock

The application runs its metastore migrations (bun-migrate) at startup and
takes a **row** in Postgres's `migration_lock` table while it does — not an
advisory lock, so it outlives the process that took it. An app container
killed mid-migration leaves the row behind, and every later start logs
`attempt to acquire lock failed` every 10 s, then `cannot acquire lock` with
`migrate: migrations table is already locked (... duplicate key value violates
unique constraint "migration_lock_table_name_key")`, and Compose reports
`container signoz-signoz-1 is unhealthy`.

The play once did this to itself: `flush_handlers` sat *before* "Converge
pinned containers", so on a fresh host `Restart SigNoz` started the whole
stack and `Recreate the SigNoz application` killed and recreated the app two
seconds later. It passed on Vultr by timing alone and failed on the first
DigitalOcean create. The flush now runs *after* the converge, whose single
`up --wait` completes the migrations before returning, so the recreate lands
on a migrated application — and still before the API wait and the gates.

Recovery, safe only when no application container is running:

```sh
ssh <profile>
cd /opt/signoz
docker compose stop signoz
docker compose exec -T metastore psql -U signoz -d signoz -c 'delete from migration_lock'
```

then re-converge with `create`.

`signoz-smoke` also asserts that an *unauthenticated* write is refused. An
endpoint that accepts both is indistinguishable from a working one unless that
is checked.

## SSH lifecycle and local configuration

Read `../workspace/standards/ssh-keypair.md` and `ssh-config.md` before edits.
The library owns key mode, registration preflight, journaled generation,
fingerprint checks and cleanup. Managed keys live at `~/.ssh/<profile>` and
are removed only after owned compute resources are destroyed. External provider
key references may use `ssh-private-key-path` or operator/agent SSH configuration; external key material is never
generated, rotated or deleted. There is no package `ssh-cleanup` step.

The package SSH helper only formats identities and deterministic build paths.
Build/dry-run use `/home/build-placeholder/.ssh/<profile>` and never inspect
operator key files or `~/.ssh/config`. Application Ansible uses the returned
login and explicit identity for both managed and external keys.

The package-owned `ansible-local/main.yml` contains the workspace locked,
atomic SSH-config updater. Keep its Python implementation identical across
colors. Runtime alias, address, user and removal mode arrive as Ansible
extra-vars, never rendered machine addresses. The managed block uses the profile
alias and includes `IdentityFile`/`IdentitiesOnly` only in managed mode. The
updater refuses conflicting unmanaged stanzas and leading global options.
Create updates the block after compute and before DNS/convergence; delete
removes it before compute destruction. Never replace this with `blockinfile`
or move key cleanup ahead of resource destruction.

## Build and migration checks

The four shared fixtures exercise managed/external keys on two adapters;
they are regression examples, not a package provider allowlist. Run native
Blue/Red/Green tests, Red typecheck, `scripts/parity.sh`, `scripts/golden.sh`
and `scripts/launcher.sh`. Golden acceptance requires reviewing the generated
application changes first. `scripts/check-compute-plan.py` checks singleton
stages, exact backend keys, absence of inline backend secrets and absence of
the old compute stage. Run the root example build with its workdir directed
to a temporary directory; it is separate from fixture coverage.

After dependency changes, build actual copied standalone payloads with no
`*_LIB_ROOT` overrides. Local tests alone do not prove their dependency pins.
Keep unrelated untracked compute-matrix artifacts out of migration commits.
Do not claim live deployment verification from an offline build.

## Secrets

Three operator credentials reach the host, and none of them may be rendered.
They appear in `main.yml` as literal `{{ lookup('env','COLORS_PAR_...') }}`
expressions, which `preserve-jinja-delimiters` passes through untouched;
Ansible resolves them at execution time. Routing them through the Selmer data
map instead would HTML-escape the quotes and hand Ansible `&#39;` — that bug
was written and caught here once already. `scripts/golden.sh` fails if those
expressions stop appearing.

The ingestion token and the Postgres password are generated on the server and
exist nowhere else.

## Commands

The three implementations live in the tri-colour layout, matching `clickstack`
and `netbird`: canonical Clojure in `green/` (`green/bb.edn`, `green/deps.edn`,
`green/src/`, `green/tasks/`, tests under `green/test/clj`), TypeScript/Bun in
`red/`, and Python/uv in `blue/`. Green is canonical: a behavioural change
lands in all three colours in the same commit and passes `scripts/parity.sh`,
which renders all four fixtures through every colour and diffs the trees — and
the colour template trees (`red/resources`, blue's embedded `resources/`) —
byte for byte. The four fixtures and the goldens are shared across colours at the
repository root — `test/fixtures/` and `test/resources/golden/` — with
`green/test/fixtures` and `green/test/resources` symlinks pointing at them.
Each colour dir holds a launcher symlink to its skill payload (`green/green`,
`red/red`, `blue/blue`).

```sh
cd green && bb test
cd green && bb golden
cd green && bb golden:accept
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh            # three colours, four fixtures, byte for byte
./scripts/launcher.sh          # from the repository root
cd green && ./green build
cd green && ./green create --dry-run
cd green && ./green create     # requires explicit authorization
cd green && ./green delete     # guarded and destructive
```

Never read `.envrc.private`, edit `.colors/`, export `COLORS_PAR_PROFILE`, or
weaken `compute-prevent-destroy`. Build and dry-run are credential-free and
must not touch `~/.ssh`.

## Dependency pins and launchers

Keep colors-compute's revision aligned in all three manifests/locks, the root
Red manifest, Blue PEP723 payload metadata and `green/tasks/pin.clj`. ONCE is
still pinned at `38e3cd66674a32fb96605e1b17ae6791086ad5c1` for application DNS
backend credential mapping and utility helpers; it no longer owns compute or
machine keys for this package. S3 credentials stay ambient. Preserve the DNS
R2 credential mapping when changing ONCE helpers.

Use `SIGNOZ_LIB_ROOT` for repository development. Canonical `bb pin` in
`green/` stamps the three launchers only after the source commit is pushed.
Use a clean temporary worktree if unrelated untracked files prevent pinning;
never fabricate a SHA or include those files merely to satisfy the guard.
Then test the copied payloads, commit and push the stamps. Deployment
launchers are copies, not symlinks. Avoid duplicate transitive Git package
entries in Red's standalone PINS: Bun can fail before package loading.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
