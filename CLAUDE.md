# CLAUDE.md

## Repository

`signoz` is a tri-colour Package Skill (green, red, blue) for a single-node
SigNoz observability stack on one Vultr instance. OpenTofu manages the instance, a firewall
(22/80/443), and a proxied Cloudflare A record; Ansible converges a Docker
Compose stack of ClickHouse, ClickHouse Keeper, a Postgres metastore, the
schema migrator, the SigNoz application, the signoz-otel-collector ingester,
and Caddy. The first consumer is `../signoz-vultr`.

One public host carries both halves: Caddy serves the SigNoz UI and proxies
OTLP/HTTP on the standard `/v1/{logs,traces,metrics}` paths to the collector,
so an exporter needs only `https://<signoz-host>` plus a bearer token. Every
other port is bound to loopback, which is why the firewall opens only 80/443
and never 4317/4318.

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

`bb golden` renders two fixtures because the keypair standard has two modes:
keygen (`test/fixtures/colors.yml`) and opt-out (`test/fixtures/optout.yml`). A
change that only holds in one of them is not conforming.

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
which renders both fixtures through every colour and diffs the trees — and the
colour template trees (`red/resources`, blue's embedded `resources/`) — byte
for byte. The two fixtures and the goldens are shared across colours at the
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
./scripts/parity.sh            # three colours, two fixtures, byte for byte
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
helper, and the whole SSH keypair implementation — so the ONCE pin can never go
below `bc06f2f`, the commit that moved the machine keypair into the operator's
`~/.ssh`. Use `GREEN_LIB_ROOT`, `ONCE_LIB_ROOT`, and `SIGNOZ_LIB_ROOT` for
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
