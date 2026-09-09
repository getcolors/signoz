import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import { providers } from "package-once-red";
import * as compute from "./compute.ts";
import {keyMode} from "colors-compute-red";

export const profilePar = parName("profile");

export const defaultComputeProvider="vultr";

export const required = [
  "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
  "compute-prevent-destroy",
  "signoz-host", "signoz-root-email", "signoz-root-org-name",
  "signoz-image", "signoz-collector-image", "signoz-clickhouse-image",
  "signoz-clickhouse-keeper-image", "signoz-postgres-image", "signoz-caddy-image",
  "signoz-histogram-quantile-version", "signoz-ingestion-token-file",
  "signoz-backup-dir", "signoz-backup-r2-bucket", "signoz-backup-r2-endpoint",
  "signoz-backup-r2-region", "signoz-backup-oncalendar",
  "signoz-backup-retention-days",
];

export const imageKeys = [
  "signoz-image", "signoz-collector-image", "signoz-clickhouse-image",
  "signoz-clickhouse-keeper-image", "signoz-postgres-image", "signoz-caddy-image",
];

const hostRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const emailRe = /^[^@\s]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const imageRe = /^[^\s:@]+(?:\/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64})$/;
const absPathRe = /^\/[^\s]*$/;

export function missing(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "");
}

// `<provider>-<suffix>`: desired state names compute keys after the provider,
// so the shared steps reach them through the selected provider rather than a
// fixed prefix. ONCE's; named here so `tools` reads the same.
export function keygen(opts:Opts){try{return keyMode(opts).mode==='managed';}catch{return true;}}

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set; profile must come from colors.yml only`]
    : [];
}

// Every problem with desired state at once: the missing keys (this package's
// and the selected provider's), the package's own checks, then the Compute
// Provider Standard's — selection, the network contract and the provider
// rules — which are ONCE's over `spec`.
export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of required) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
  }
  if (opts["provider-dns"] !== "cloudflare") {
    errors.push(":provider-dns must be cloudflare");
  }
  if (!["s3", "r2"].includes(String(opts["provider-backend"]))) {
    errors.push(":provider-backend must be s3 or r2");
  }
  if (typeof opts["compute-prevent-destroy"] !== "boolean") {
    errors.push(":compute-prevent-destroy must be true or false");
  }
  if (!missing(opts["signoz-host"]) && !hostRe.test(String(opts["signoz-host"]))) {
    errors.push(":signoz-host must be a fully qualified hostname");
  }
  if (!missing(opts["signoz-root-email"]) &&
      !emailRe.test(String(opts["signoz-root-email"]))) {
    errors.push(":signoz-root-email must be an email address");
  }
  for (const key of imageKeys) {
    const value = opts[key];
    if (!missing(value) && !imageRe.test(String(value))) {
      errors.push(`:${key} must carry an explicit image tag or digest`);
    }
  }
  // The application and the collector version independently upstream, and the
  // collector owns the ClickHouse schema the application queries. There is no
  // rule that can check the pair is compatible, so the one thing that can be
  // checked is that neither floats.
  for (const key of ["signoz-image", "signoz-collector-image"]) {
    const value = String(opts[key] ?? "");
    if (value.endsWith(":latest") || value.endsWith(":main")) {
      errors.push(`:${key} must not track a floating tag; pin the version`);
    }
  }
  if (!missing(opts["signoz-ingestion-token-file"]) &&
      !absPathRe.test(String(opts["signoz-ingestion-token-file"]))) {
    errors.push(":signoz-ingestion-token-file must be an absolute path");
  }
  if (!missing(opts["signoz-backup-dir"]) &&
      !absPathRe.test(String(opts["signoz-backup-dir"]))) {
    errors.push(":signoz-backup-dir must be an absolute path");
  }
  const retention = opts["signoz-backup-retention-days"];
  if (!(missing(retention) ||
        (typeof retention === "number" && Number.isInteger(retention) && retention > 0))) {
    errors.push(":signoz-backup-retention-days must be a positive integer");
  }
  errors.push(...compute.errors(opts));
  return errors;
}

export function backendSecrets(opts: Opts): string[] {
  return providers["provider-backend"]?.[String(opts["provider-backend"])]?.secrets ?? [];
}

// What talking to the providers needs, on any real event: the selected
// compute provider's credential and Cloudflare's.
export function providerSecrets(opts: Opts): string[] {
  return ["cloudflare-api-token"];
}

// What converging the machine needs, and therefore only a create. The OTLP
// ingestion token and the Postgres password are deliberately absent: both are
// generated on the server and are never supplied by the operator.
export const applicationSecrets = [
  "signoz-root-password",
  "signoz-backup-r2-access-key-id",
  "signoz-backup-r2-secret-access-key",
];

// Credentials a real event needs. A delete tears down infrastructure and never
// converges anything, so it asks for the provider credentials only; demanding
// the root password to destroy a machine would just be a lock on the exit.
export function secretErrors(opts: Opts, event: string): string[] {
  const keys = [...new Set([
    ...providerSecrets(opts),
    ...(event === "create" ? applicationSecrets : []),
    ...backendSecrets(opts),
  ])];
  return keys.filter((key) => missing(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  switch (slot) {
    case "provider-compute":
      return {};
    case "provider-dns":
      return { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" };
    case "provider-backend":
      return providers["provider-backend"]?.[String(opts["provider-backend"])]?.tofuEnv ?? {};
    default:
      return {};
  }
}
