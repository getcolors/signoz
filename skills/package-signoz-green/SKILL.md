---
name: package-signoz-green
description: Provision and manage a single-node SigNoz observability stack on one VM through colors-compute — ClickHouse, ClickHouse Keeper, a Postgres metastore, the SigNoz application, the signoz-otel-collector ingester and Caddy — with OpenTofu, Ansible and Cloudflare DNS. Use when asked to deploy, converge, inspect or tear down self-hosted SigNoz, to send OpenTelemetry traces, logs or metrics to a private backend, or to work on a colors.yml for a signoz deployment.
---

# SigNoz Package Skill (Green)

Provisions one VM through colors-compute running SigNoz behind
Caddy, with a proxied Cloudflare `A` record and OpenTofu state in Cloudflare R2.

## Install the launcher

```sh
npx skills add getcolors/signoz
cp .agents/skills/package-signoz-green/green ./green
chmod +x green
```

The root `green` is a **copy** of the payload, not a symlink. `npx skills
update -p` rewrites the payload and leaves the copy alone, so copy it again
after every update or the project keeps running the old pin.

## Verbs

```sh
./green build              # render .colors/<profile>/ — no provider calls, no credentials
./green create --dry-run   # walk the workflow, skip every side effect
./green create             # converge for real
./green delete             # guarded and destructive
```

`build` and `--dry-run` are the safe way to check a `colors.yml` edit: they
work on a fresh checkout with an empty environment. Exit code 2 is a validation
or usage failure and lists every problem at once. The launcher walks up from
the working directory to find `colors.yml`, so any subdirectory works.

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

## Rules that are not negotiable

- **`colors.yml` is the only file you edit.** Kebab-case keys, non-secret
  values only.
- **Credentials are `COLORS_PAR_*` environment variables** in a gitignored
  `.envrc.private`. Never in `colors.yml`, generated output, or documentation.
- **Never export `COLORS_PAR_PROFILE`.** The profile keys remote state; the
  package refuses to run when it is set, and that refusal is the guard working.
- **`.colors/` is generated output.** Never edit it, never read it as source,
  never commit it.
- **`delete` is guarded** by `compute-prevent-destroy: true`, liftable only
  with `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false` for one run. Never edit the
  committed flag. Never run a real `create` or `delete` against a live
  deployment without explicit authorization.

## What it builds

| Stage | What it manages |
|---|---|
| `compute/shared`, `compute/nodes/0` | library-owned network policy, managed key registration and one node |
| `signoz-ssh-config` | the `~/.ssh/config` block, so `ssh <profile>` works |
| `signoz-dns` | one proxied Cloudflare `A` record |
| `signoz-ansible` | Docker Compose: ClickHouse, ClickHouse Keeper, Postgres, the migrator, SigNoz, the ingester, Caddy |
| acceptance | the public UI over HTTPS, and an OTLP endpoint that refuses an unauthenticated write |

## Ingestion

SigNoz community edition has **no ingestion keys** — that is a SigNoz Cloud
feature. Caddy admits `/v1/{logs,traces,metrics}` only with a bearer token
generated on the server; everything else on the host is the UI. Read the token
with `ssh <profile> cat /etc/signoz/ingestion.env` and send it as
`Authorization: Bearer <token>`. Only OTLP/HTTP is published; gRPC on 4317
stays on loopback.

## Reference

`references/configuration.md` documents every `colors.yml` key and every
credential.
