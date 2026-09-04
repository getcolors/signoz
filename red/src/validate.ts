import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import { providers } from "package-once-red";
import { onceSsh } from "./once.ts";

export const profilePar = parName("profile");

interface ProviderEntry {
  required: string[];
  secrets: string[];
  tofuEnv: Record<string, string>;
}

// provider-compute -> what that choice implies.
//
// `required` are the non-secret keys that provider's template interpolates,
// `secrets` the credentials it needs through COLORS_PAR_*, and `tofuEnv` the
// subset OpenTofu reads from the process environment itself. Keeping the three
// together is what stops a provider being validated against one set of keys and
// run with another — a stage exporting a credential nobody checked for, or a
// check demanding a key no template uses. The keys of this map are the
// advertised providers; a provider without a template directory and a golden
// is not advertised.
//
// Two keys the templates read are deliberately not required. `<provider>-name`
// is an optional override of the profile (Compute Name Standard), and
// `<provider>-ssh-keys` is meaningful by its absence (SSH Keypair Standard).
// Keys of the unselected provider are accepted and ignored, so one colors.yml
// stays portable between providers.
export const computeProviders: Record<string, ProviderEntry> = {
  digitalocean: {
    required: ["digitalocean-region", "digitalocean-size", "digitalocean-image",
               "digitalocean-ssh-sources", "digitalocean-http-sources"],
    secrets: ["do-token"],
    tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
  },
  vultr: {
    required: ["vultr-region", "vultr-plan", "vultr-os-id",
               "vultr-ssh-sources", "vultr-http-sources"],
    secrets: ["vultr-api-key"],
    tofuEnv: { "vultr-api-key": "VULTR_API_KEY" },
  },
};

// The provider a deployment created before this package recorded one in its
// compute output must be running: the only one it ever offered.
export const defaultComputeProvider = "vultr";

// Every key desired state must carry whichever provider is selected. The
// provider-scoped keys come from `computeProviders`.
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
  "r2-bucket", "r2-endpoint",
];

export const imageKeys = [
  "signoz-image", "signoz-collector-image", "signoz-clickhouse-image",
  "signoz-clickhouse-keeper-image", "signoz-postgres-image", "signoz-caddy-image",
];

const hostRe = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const emailRe = /^[^@\s]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const imageRe = /^[^\s:@]+(?:\/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64})$/;
const absPathRe = /^\/[^\s]*$/;

// What each provider accepts as a machine name, checked here rather than
// discovered mid-apply. DigitalOcean droplet names are hostname-like; Vultr
// labels are free-form console text, held to a safe subset.
const nameRules: Record<string, { re: RegExp; message: string }> = {
  digitalocean: {
    re: /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
    message: "must be a hostname-like name: lowercase letters, digits, dots and hyphens, 1-63 characters",
  },
  vultr: {
    re: /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/,
    message: "must be a safe 1-63 character name",
  },
};

export function missing(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "");
}

// Whether a value is missing in the ways a hand-edited file produces: absent,
// blank, or still carrying the scaffold's REPLACE_ME.
export function placeholder(value: unknown): boolean {
  return missing(value) || String(value).toUpperCase() === "REPLACE_ME";
}

export function computeProvider(opts: Opts): ProviderEntry | undefined {
  return computeProviders[String(opts["provider-compute"])];
}

// Desired state names compute keys after the provider, so the shared steps
// reach them through the selected provider rather than a fixed prefix.
export function computeKey(opts: Opts, suffix: string): string {
  return `${opts["provider-compute"]}-${suffix}`;
}

// What this deployment's machine is called. The profile is the deployment's
// identity — it keys remote state, names the machine keypair and its provider
// registration, and is the `~/.ssh/config` alias an operator types — so the
// machine's own label must not be the one place that disagrees (Compute Name
// Standard §1). `<provider>-name` overrides it for an account whose naming
// policy a profile cannot satisfy; presence is the only switch, and resolving
// it here means the templates render one value and never branch (§2). The
// firewall derives its name from the same answer (§3).
export function computeName(opts: Opts): string {
  const override = opts[computeKey(opts, "name")];
  return placeholder(override) ? String(opts.profile) : String(override);
}

// Whether this deployment owns its machine keypair. Delegates to ONCE, the
// standard's reference implementation, so one rule decides it everywhere.
export function keygen(opts: Opts): boolean {
  return onceSsh.keygen(opts);
}

// A source list as desired state or an overlay string carries it: a YAML
// list, or one string of comma- or space-separated entries.
export function cidrs(opts: Opts, key: string): string[] {
  const value = opts[key];
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/);
  return parts.map((part) => String(part).trim()).filter((part) => part.length > 0);
}

// Syntactic CIDR checks, the same in every colour and deliberately not a
// resolver: an address library that accepts a hostname would let a firewall
// source depend on DNS at apply time.
const ipv4Re = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const hexGroupRe = /^[0-9A-Fa-f]{1,4}$/;

function ipv6Address(raw: string): boolean {
  // An IPv4-embedded tail (`::ffff:192.0.2.1`) may stand in the last position
  // only, where it occupies two groups; it is folded into two zero groups so
  // the group arithmetic below stays the same in every colour.
  const colon = raw.lastIndexOf(":");
  if (colon < 0) return false;
  const tail = raw.slice(colon + 1);
  let s = raw;
  if (tail.includes(".")) {
    if (!ipv4Re.test(tail)) return false;
    s = `${raw.slice(0, colon + 1)}0:0`;
  }
  const groups = (part: string) => (part.trim() === "" ? [] : part.split(":"));
  if (s.includes("::")) {
    const halves = s.split("::");
    if (halves.length !== 2) return false;
    const gs = halves.flatMap(groups);
    return gs.length <= 7 && gs.every((g) => hexGroupRe.test(g));
  }
  const gs = groups(s);
  return gs.length === 8 && gs.every((g) => hexGroupRe.test(g));
}

// Whether `s` is a syntactically valid IPv4 or IPv6 CIDR: an address, a
// slash, and a prefix length the address family allows.
export function cidr(s: unknown): boolean {
  const [address, prefix, ...more] = String(s).split("/");
  if (more.length > 0 || prefix === undefined || !/^\d{1,3}$/.test(prefix)) return false;
  const n = Number(prefix);
  if (ipv4Re.test(address ?? "")) return n >= 0 && n <= 32;
  if (ipv6Address(address ?? "")) return n >= 0 && n <= 128;
  return false;
}

// The network contract: the selected provider's SSH sources must name at
// least one CIDR — a machine nobody can reach is not a deployment — and every
// entry of both lists must be one. An empty HTTP list is allowed and means no
// public HTTP. Refusing beats defaulting: a silent default-open on a host that
// holds telemetry is worse than a validation error.
export function sourceErrors(opts: Opts): string[] {
  const sshKey = computeKey(opts, "ssh-sources");
  const httpKey = computeKey(opts, "http-sources");
  const errors: string[] = [];
  if (!missing(opts[sshKey]) && cidrs(opts, sshKey).length === 0) {
    errors.push(`:${sshKey} must list at least one CIDR`);
  }
  for (const key of [sshKey, httpKey]) {
    if (missing(opts[key])) continue;
    for (const entry of cidrs(opts, key)) {
      if (!cidr(entry)) errors.push(`:${key} entry ${JSON.stringify(entry)} is not an IPv4 or IPv6 CIDR`);
    }
  }
  return errors;
}

// Checks that hold only for the selected provider. Keys of the other provider
// are ignored, never refused.
export function providerErrors(opts: Opts): string[] {
  const errors: string[] = [];
  // The *resolved* machine name is what reaches the provider, so it is what
  // the rule checks: an explicit override, or the profile it falls back to.
  // The error names whichever key produced the value.
  const nameKey = computeKey(opts, "name");
  const rule = nameRules[String(opts["provider-compute"])];
  const name = computeName(opts);
  const source = placeholder(opts[nameKey])
    ? `:profile (the ${opts["provider-compute"]} machine name)`
    : `:${nameKey}`;
  if (rule && !missing(name) && (name.length > 63 || !rule.re.test(name))) {
    errors.push(`${source} ${rule.message}`);
  }
  switch (opts["provider-compute"]) {
    case "vultr": {
      const osId = opts["vultr-os-id"];
      if (!(missing(osId) || (typeof osId === "number" && Number.isInteger(osId)))) {
        errors.push(":vultr-os-id must be Vultr's numeric operating-system id");
      }
      break;
    }
    case "digitalocean":
      // No VPC is created: the region's default is discovered at plan time,
      // and a pinned UUID or a CIDR would make this package start owning one.
      if ("digitalocean-vpc-uuid" in opts) {
        errors.push(":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime");
      }
      if ("digitalocean-vpc-cidr" in opts) {
        errors.push(":digitalocean-vpc-cidr must be absent; this package must not create a VPC");
      }
      break;
    default:
      break;
  }
  return errors;
}

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set; profile must come from colors.yml only`]
    : [];
}

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  const provider = computeProvider(opts);
  for (const key of [...required, ...(provider?.required ?? [])]) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
  }
  if (!provider) {
    errors.push(`:provider-compute must be one of ${Object.keys(computeProviders).sort().join(", ")}`);
  }
  if (opts["provider-dns"] !== "cloudflare") {
    errors.push(":provider-dns must be cloudflare");
  }
  if (!["local", "s3", "r2"].includes(String(opts["provider-backend"]))) {
    errors.push(":provider-backend must be local, s3, or r2");
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
  if (provider) errors.push(...providerErrors(opts), ...sourceErrors(opts));
  return errors;
}

// Provider switching is a rebuild, never an apply. Every provider shares one
// state key, so a changed provider-compute on a profile whose state already
// holds compute would plan a cross-provider replacement — and a delete would
// render and destroy the *selected* provider's template against the wrong
// lifecycle. `params` is the compute stage's recorded output, or undefined
// when the state holds none; its `provider` is the registry name the template
// that produced it belongs to. A recorded output without one predates this
// package recording it, which makes it the default provider's.
export function providerStateErrors(
  opts: Opts,
  params: Record<string, unknown> | undefined,
): string[] {
  if (!params) return [];
  const selected = String(opts["provider-compute"]);
  const recorded = String(params.provider ?? "");
  if (recorded.length > 0 && recorded !== selected) {
    return [`state holds a ${recorded} machine; set provider-compute back to ${recorded} and delete first`];
  }
  if (recorded.length === 0 && selected !== defaultComputeProvider) {
    return ["state holds a machine with no recorded provider, created before this " +
      `package recorded one, which makes it a ${defaultComputeProvider} machine; ` +
      `set provider-compute back to ${defaultComputeProvider} and delete first`];
  }
  return [];
}

export function backendSecrets(opts: Opts): string[] {
  return providers["provider-backend"]?.[String(opts["provider-backend"])]?.secrets ?? [];
}

// What talking to the providers needs, on any real event: the selected
// compute provider's credential and Cloudflare's.
export function providerSecrets(opts: Opts): string[] {
  return [...(computeProvider(opts)?.secrets ?? []), "cloudflare-api-token"];
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
      return computeProvider(opts)?.tofuEnv ?? {};
    case "provider-dns":
      return { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" };
    case "provider-backend":
      return providers["provider-backend"]?.[String(opts["provider-backend"])]?.tofuEnv ?? {};
    default:
      return {};
  }
}
