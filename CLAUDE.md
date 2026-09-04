# CLAUDE.md

## Repository

`signoz` is a tri-colour Package Skill (green, red, blue) for a single-node
SigNoz observability stack on one Vultr instance or one DigitalOcean droplet.
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

## Two compute providers

The package supports two compute providers, selected by template directory —
`tools/infrastructure/vultr/` and `tools/infrastructure/digitalocean/` —
rather than by conditionals, so a build is the only thing that proves a
provider's tree renders at all. The registry is `compute-providers` in
`validate.clj` (mirrored in `validate.ts` and `validate.py`): provider name to
its required keys, its secret (`:vultr-api-key` or `:do-token`), and the
environment variable OpenTofu reads it from. The keys of that map are the
advertised providers; keys of the unselected provider are accepted and
ignored, never refused, so one `colors.yml` moves between providers by one
edit. `<provider>-name` is optional and resolves through `compute-name`,
profile by default (Compute Name Standard); the templates interpolate that one
value for the label, the firewall name and `params.name` and never branch.
`compute-key` is how the shared steps reach `<provider>-ssh-sources` and
`<provider>-http-sources`. The compute provider's credential is the only
secret that varies by provider: `provider-secrets` derives it from the
registry, and the create-only application secrets (root password, backup R2
keys) are the same on both.

Every provider's compute stage outputs the same `params` —
`{provider, ip, user, sudoer, name, ssh_key_id (keygen only)}` — and
`provider` is the switch guard. Both providers share one state key, so a
changed `provider-compute` on a profile whose state already holds a machine
would plan a cross-provider replacement, and a delete would render and destroy
the *selected* provider's template against the wrong lifecycle. `start-step`
therefore reads the state once, up front, with backend credentials alone, and
a validator placed after `state-errors` and before the credential check
refuses a real create or delete whose recorded provider differs from the
selected one (`state holds a <recorded> machine; set provider-compute back to
<recorded> and delete first`). The order is deliberate: a mistaken provider
edit reports the actionable error, not a missing token for the provider that
was just selected. A recorded `params` without `provider` predates this
package recording one and is treated as Vultr, the only provider it ever
offered. An unreadable backend is not an empty state: on a real create it
counts as no state (a fresh clone has none), on a real delete `adopt-state`
fails closed rather than proceeding with nothing to address, and a real create
whose compute output carries no `ip` refuses to converge against the
documentation address (`resolved-compute`).

The operations behind all of that are not this package's code. Since the
delegation, ONCE's `compute` namespace (`io.github.getcolors.once.compute`,
the `compute` export of `package-once-red`, `package_once_blue.compute`)
implements the Compute Provider Standard: selection, the CIDR grammar and the
network contract, the name rules, the switch and legacy-state refusals, the
missing-`ip` refusal, the state read and its adoption. What lives here is the
data and the wiring — the registry, the default provider, the `spec` value in
each colour's `validate` that hands both plus the sources map to ONCE, the
templates, the fixtures and goldens, `state-output`, and the `start-step`
preflight that calls ONCE's functions in the order above with this package's
event-aware `secret-errors` as the thunk. `compute-name`, `compute-key`,
`cidrs`, `fallback-params` and `resolved-compute` remain as package-named
aliases so `tools` and the tests read as before. The pure-function matrix
(CIDR table, name rules, per-provider checks, the switch rules) is tested in
ONCE, in all three colours and by its parity drivers; this repository tests
the wiring — one test per safety boundary through `start-step` — and one
spec-content test per colour, so a colour whose spec drifts fails in that
colour. clickstack is the reference consumer of that namespace.

The provider firewall is the load-bearing network layer on both providers and
Ansible manages no host firewall for its ports. `state-errors` refuses an
empty `<provider>-ssh-sources` and any entry that is not a syntactically valid
IPv4 or IPv6 CIDR, before any provider call; an empty HTTP list means no public
HTTP. On DigitalOcean the droplet joins the region's default VPC, discovered
at plan time, and `digitalocean-vpc-uuid` and `digitalocean-vpc-cidr` are
refused. The DigitalOcean template emits its 80/443 rules through a `dynamic`
block because a DigitalOcean inbound rule with no source is an API error, not
a closed port. 4317/4318 are opened on neither provider.

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

## The SSH keypair and `~/.ssh/config`

This package is born conforming to both workspace standards. Read
`../workspace/standards/ssh-keypair.md` before touching `ssh.clj` (or its
red/blue counterparts) and `../workspace/standards/ssh-config.md` before
touching `ssh_config.clj` (or its counterparts).

The keypair behaviour is ONCE's (`io.github.getcolors.once.ssh`), deliberately
reused so one standard has one implementation. The `~/.ssh/config` block is
this package's own copy, per the config standard §7: that file is shared with
every other host the operator reaches, so an unrelated upstream change must not
rewrite it at pin-bump time. The two disagree on ordering on purpose — the
config block is removed *before* the compute destroy, the keypair *after* it.

What this repository adds is the build placeholder: `build` and `--dry-run`
render `/home/build-placeholder/.ssh/<profile>` rather than reading `~/.ssh`,
which is what makes the committed goldens mean the same thing on every
workstation.

`bb golden` renders four fixtures: one per advertised provider per keypair
mode, because the keypair standard has two modes — keygen
(`test/fixtures/colors.yml`, `colors-digitalocean.yml`) and opt-out
(`optout.yml`, `optout-digitalocean.yml`) — and a change that only holds in
one of them, or on one provider, is not conforming. The two DigitalOcean
fixtures also split the Compute Name Standard: the keygen one carries no
`digitalocean-name` and proves the profile default, the opt-out one sets it to
the profile. The Vultr fixtures keep `vultr-name` equal to the profile so
their goldens stayed byte-identical through adoption, apart from the
`provider` line in `params`. The keypair behaviour is ONCE's, and which
desired-state key carries the machine key comes from ONCE's
`machine-key-keys` table, never a literal, which is what lets the build
placeholder land on the right key for either provider.

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

## Coupling

The package pins Green and ONCE in `green/deps.edn`, the Red SDK and
`package-once-red` in `red/package.json`, and the Blue SDK and
`package-once-blue` in `blue/pyproject.toml`. All three colours pin ONCE at the
**same rev** — ONCE's own parity is what guarantees its colours agree per
commit. ONCE supplies the backend provider registry, the registrable-domain
helper, the whole SSH keypair implementation, and the Compute Provider
Standard's operations (`compute`) — so the ONCE pin can never go below
`04f9623`, the first commit whose `compute` reads a missing stage directory
as an unreadable state rather than letting the green SDK's `IOException`
crash a fresh-clone create, itself above `bc06f2f`, the commit that moved the
machine keypair into the operator's `~/.ssh`. Use `GREEN_LIB_ROOT`,
`ONCE_LIB_ROOT`, and `SIGNOZ_LIB_ROOT` for
working-tree development (`SIGNOZ_LIB_ROOT` names the repository root for every
colour; red also accepts the `red/` dir directly). Final launchers use a pushed
SHA managed by `bb pin`, which stamps all three payloads from their unpinned
birth forms; deployment launchers are copies, not symlinks.

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
