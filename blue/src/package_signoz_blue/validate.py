"""Validation over desired state, the port of io.github.getcolors.signoz.validate.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import json
import re

from blue.cli import par_name
from package_once_blue import ssh as once_ssh
from package_once_blue.validate import providers as once_providers

profile_par = par_name("profile")

# provider-compute -> what that choice implies.
#
# `required` are the non-secret keys that provider's template interpolates,
# `secrets` the credentials it needs through COLORS_PAR_*, and `tofu-env` the
# subset OpenTofu reads from the process environment itself. Keeping the three
# together is what stops a provider being validated against one set of keys and
# run with another — a stage exporting a credential nobody checked for, or a
# check demanding a key no template uses. The keys of this map are the
# advertised providers; a provider without a template directory and a golden
# is not advertised.
#
# Two keys the templates read are deliberately not required. `<provider>-name`
# is an optional override of the profile (Compute Name Standard), and
# `<provider>-ssh-keys` is meaningful by its absence (SSH Keypair Standard).
# Keys of the unselected provider are accepted and ignored, so one colors.yml
# stays portable between providers.
compute_providers = {
    "digitalocean": {
        "required": ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                     "digitalocean-ssh-sources", "digitalocean-http-sources"],
        "secrets": ["do-token"],
        "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
    },
    "vultr": {
        "required": ["vultr-region", "vultr-plan", "vultr-os-id",
                     "vultr-ssh-sources", "vultr-http-sources"],
        "secrets": ["vultr-api-key"],
        "tofu-env": {"vultr-api-key": "VULTR_API_KEY"},
    },
}

# The provider a deployment created before this package recorded one in its
# compute output must be running: the only one it ever offered.
default_compute_provider = "vultr"

# Every key desired state must carry whichever provider is selected. The
# provider-scoped keys come from `compute_providers`.
required = [
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
]

image_keys = [
    "signoz-image", "signoz-collector-image", "signoz-clickhouse-image",
    "signoz-clickhouse-keeper-image", "signoz-postgres-image", "signoz-caddy-image",
]

host_re = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+")
email_re = re.compile(r"[^@\s]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+")
image_re = re.compile(r"[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64})")
abs_path_re = re.compile(r"/[^\s]*")

# What each provider accepts as a machine name, checked here rather than
# discovered mid-apply. DigitalOcean droplet names are hostname-like; Vultr
# labels are free-form console text, held to a safe subset.
name_rules = {
    "digitalocean": {
        "re": re.compile(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?"),
        "message": "must be a hostname-like name: lowercase letters, digits, dots and hyphens, 1-63 characters",
    },
    "vultr": {
        "re": re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,62}"),
        "message": "must be a safe 1-63 character name",
    },
}


def _s(value) -> str:
    """Clojure's `str`: nil renders empty, booleans lowercase."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def missing(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def placeholder(value) -> bool:
    """Whether a value is missing in the ways a hand-edited file produces:
    absent, blank, or still carrying the scaffold's REPLACE_ME."""
    return missing(value) or _s(value).upper() == "REPLACE_ME"


def compute_provider(opts: dict) -> dict | None:
    return compute_providers.get(_s(opts.get("provider-compute")))


def compute_key(opts: dict, suffix: str) -> str:
    """Desired state names compute keys after the provider, so the shared steps
    reach them through the selected provider rather than a fixed prefix."""
    return f"{_s(opts.get('provider-compute'))}-{suffix}"


def compute_name(opts: dict) -> str:
    """What this deployment's machine is called. The profile is the
    deployment's identity — it keys remote state, names the machine keypair and
    its provider registration, and is the `~/.ssh/config` alias an operator
    types — so the machine's own label must not be the one place that disagrees
    (Compute Name Standard §1). `<provider>-name` overrides it for an account
    whose naming policy a profile cannot satisfy; presence is the only switch,
    and resolving it here means the templates render one value and never
    branch (§2). The firewall derives its name from the same answer (§3)."""
    override = opts.get(compute_key(opts, "name"))
    return _s(opts.get("profile")) if placeholder(override) else _s(override)


def keygen(opts: dict) -> bool:
    """Whether this deployment owns its machine keypair. Delegates to ONCE, the
    standard's reference implementation, so one rule decides it everywhere."""
    return once_ssh.keygen(opts)


def cidrs(opts: dict, key: str) -> list[str]:
    """A source list as desired state or an overlay string carries it: a YAML
    list, or one string of comma- or space-separated entries."""
    value = opts.get(key)
    xs = value if isinstance(value, list) else re.split(r"[,\s]+", _s(value))
    return [s for s in (_s(x).strip() for x in xs) if s]


# Syntactic CIDR checks, the same in every colour and deliberately not a
# resolver: an address library that accepts a hostname would let a firewall
# source depend on DNS at apply time.
_ipv4_re = re.compile(
    r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}")
_hex_group_re = re.compile(r"[0-9A-Fa-f]{1,4}")


def _ipv6_address(s: str) -> bool:
    # An IPv4-embedded tail (`::ffff:192.0.2.1`) may stand in the last position
    # only, where it occupies two groups; it is folded into two zero groups so
    # the group arithmetic below stays the same in every colour.
    colon = s.rfind(":")
    if colon < 0:
        return False
    tail = s[colon + 1:]
    if "." in tail:
        if not _ipv4_re.fullmatch(tail):
            return False
        s = s[:colon + 1] + "0:0"

    def groups(part: str) -> list[str]:
        return [] if not part.strip() else part.split(":")
    if "::" in s:
        halves = s.split("::")
        if len(halves) != 2:
            return False
        gs = [g for half in halves for g in groups(half)]
        return len(gs) <= 7 and all(_hex_group_re.fullmatch(g) for g in gs)
    gs = groups(s)
    return len(gs) == 8 and all(_hex_group_re.fullmatch(g) for g in gs)


def cidr(s) -> bool:
    """Whether `s` is a syntactically valid IPv4 or IPv6 CIDR: an address, a
    slash, and a prefix length the address family allows."""
    parts = _s(s).split("/")
    if len(parts) != 2 or not re.fullmatch(r"\d{1,3}", parts[1]):
        return False
    address, n = parts[0], int(parts[1])
    if _ipv4_re.fullmatch(address):
        return 0 <= n <= 32
    if _ipv6_address(address):
        return 0 <= n <= 128
    return False


def source_errors(opts: dict) -> list[str]:
    """The network contract: the selected provider's SSH sources must name at
    least one CIDR — a machine nobody can reach is not a deployment — and every
    entry of both lists must be one. An empty HTTP list is allowed and means no
    public HTTP. Refusing beats defaulting: a silent default-open on a host
    that holds telemetry is worse than a validation error."""
    ssh_key = compute_key(opts, "ssh-sources")
    http_key = compute_key(opts, "http-sources")
    errors: list[str] = []
    if not missing(opts.get(ssh_key)) and not cidrs(opts, ssh_key):
        errors.append(f":{ssh_key} must list at least one CIDR")
    for key in [ssh_key, http_key]:
        if missing(opts.get(key)):
            continue
        for entry in cidrs(opts, key):
            if not cidr(entry):
                errors.append(f":{key} entry {json.dumps(entry)} is not an IPv4 or IPv6 CIDR")
    return errors


def provider_errors(opts: dict) -> list[str]:
    """Checks that hold only for the selected provider. Keys of the other
    provider are ignored, never refused."""
    errors: list[str] = []
    # The *resolved* machine name is what reaches the provider, so it is what
    # the rule checks: an explicit override, or the profile it falls back to.
    # The error names whichever key produced the value.
    name_key = compute_key(opts, "name")
    rule = name_rules.get(_s(opts.get("provider-compute")))
    name = compute_name(opts)
    source = (f":profile (the {_s(opts.get('provider-compute'))} machine name)"
              if placeholder(opts.get(name_key)) else f":{name_key}")
    if rule and not missing(name) and (len(name) > 63 or not rule["re"].fullmatch(name)):
        errors.append(f"{source} {rule['message']}")
    provider = opts.get("provider-compute")
    if provider == "vultr":
        os_id = opts.get("vultr-os-id")
        if not (missing(os_id) or (isinstance(os_id, int) and not isinstance(os_id, bool))):
            errors.append(":vultr-os-id must be Vultr's numeric operating-system id")
    elif provider == "digitalocean":
        # No VPC is created: the region's default is discovered at plan time,
        # and a pinned UUID or a CIDR would make this package start owning one.
        if "digitalocean-vpc-uuid" in opts:
            errors.append(":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime")
        if "digitalocean-vpc-cidr" in opts:
            errors.append(":digitalocean-vpc-cidr must be absent; this package must not create a VPC")
    return errors


def env_errors(env: dict) -> list[str]:
    if _s(env.get(profile_par)):
        return [f"{profile_par} is set; profile must come from colors.yml only"]
    return []


def state_errors(opts: dict) -> list[str]:
    errors: list[str] = []
    provider = compute_provider(opts)
    errors += [f":{k} is required"
               for k in [*required, *((provider or {}).get("required", []))]
               if missing(opts.get(k))]
    if not provider:
        errors.append(":provider-compute must be one of "
                      + ", ".join(sorted(compute_providers)))
    if opts.get("provider-dns") != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if opts.get("provider-backend") not in ("local", "s3", "r2"):
        errors.append(":provider-backend must be local, s3, or r2")
    if not isinstance(opts.get("compute-prevent-destroy"), bool):
        errors.append(":compute-prevent-destroy must be true or false")
    if not (missing(opts.get("signoz-host"))
            or host_re.fullmatch(_s(opts.get("signoz-host")))):
        errors.append(":signoz-host must be a fully qualified hostname")
    if not (missing(opts.get("signoz-root-email"))
            or email_re.fullmatch(_s(opts.get("signoz-root-email")))):
        errors.append(":signoz-root-email must be an email address")
    for k in image_keys:
        v = opts.get(k)
        if not missing(v) and not image_re.fullmatch(_s(v)):
            errors.append(f":{k} must carry an explicit image tag or digest")
    # The application and the collector version independently upstream, and the
    # collector owns the ClickHouse schema the application queries. There is no
    # rule that can check the pair is compatible, so the one thing that can be
    # checked is that neither floats.
    for k in ["signoz-image", "signoz-collector-image"]:
        v = _s(opts.get(k))
        if v.endswith(":latest") or v.endswith(":main"):
            errors.append(f":{k} must not track a floating tag; pin the version")
    if not (missing(opts.get("signoz-ingestion-token-file"))
            or abs_path_re.fullmatch(_s(opts.get("signoz-ingestion-token-file")))):
        errors.append(":signoz-ingestion-token-file must be an absolute path")
    if not (missing(opts.get("signoz-backup-dir"))
            or abs_path_re.fullmatch(_s(opts.get("signoz-backup-dir")))):
        errors.append(":signoz-backup-dir must be an absolute path")
    retention = opts.get("signoz-backup-retention-days")
    if not (missing(retention)
            or (isinstance(retention, int) and not isinstance(retention, bool)
                and retention > 0)):
        errors.append(":signoz-backup-retention-days must be a positive integer")
    if provider:
        errors += provider_errors(opts) + source_errors(opts)
    return errors


def provider_state_errors(opts: dict, params: dict | None) -> list[str]:
    """Provider switching is a rebuild, never an apply. Every provider shares
    one state key, so a changed provider-compute on a profile whose state
    already holds compute would plan a cross-provider replacement — and a
    delete would render and destroy the *selected* provider's template against
    the wrong lifecycle. `params` is the compute stage's recorded output, or
    None when the state holds none; its `provider` is the registry name the
    template that produced it belongs to. A recorded output without one
    predates this package recording it, which makes it the default
    provider's."""
    if params is None:
        return []
    selected = _s(opts.get("provider-compute"))
    recorded = _s(params.get("provider"))
    if recorded and recorded != selected:
        return [f"state holds a {recorded} machine; set provider-compute back to "
                f"{recorded} and delete first"]
    if not recorded and selected != default_compute_provider:
        return ["state holds a machine with no recorded provider, created before this "
                f"package recorded one, which makes it a {default_compute_provider} "
                f"machine; set provider-compute back to {default_compute_provider} "
                "and delete first"]
    return []


def backend_secrets(opts: dict) -> list[str]:
    entry = once_providers["provider-backend"].get(str(opts.get("provider-backend")), {})
    return entry.get("secrets", [])


def provider_secrets(opts: dict) -> list[str]:
    """What talking to the providers needs, on any real event: the selected
    compute provider's credential and Cloudflare's."""
    return [*((compute_provider(opts) or {}).get("secrets", [])), "cloudflare-api-token"]

# What converging the machine needs, and therefore only a create. The OTLP
# ingestion token and the Postgres password are deliberately absent: both are
# generated on the server and are never supplied by the operator.
application_secrets = [
    "signoz-root-password",
    "signoz-backup-r2-access-key-id",
    "signoz-backup-r2-secret-access-key",
]


def secret_errors(opts: dict, event: str) -> list[str]:
    """Credentials a real event needs. A delete tears down infrastructure and
    never converges anything, so it asks for the provider credentials only;
    demanding the root password to destroy a machine would just be a lock on
    the exit."""
    keys = [*provider_secrets(opts),
            *(application_secrets if event == "create" else []),
            *backend_secrets(opts)]
    return [f"required credential is not set: {par_name(k)}"
            for k in dict.fromkeys(keys) if missing(opts.get(k))]


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return (compute_provider(opts) or {}).get("tofu-env", {})
    if slot == "provider-dns":
        return {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"}
    if slot == "provider-backend":
        entry = once_providers["provider-backend"].get(str(opts.get("provider-backend")), {})
        return entry.get("tofu-env", {})
    return {}
