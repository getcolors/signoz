"""The steps and every template spec, the port of io.github.getcolors.signoz.tools."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
import re

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec
from package_once_blue.utils import registrable_domain

from . import ssh_config, validate

infrastructure_tool = "signoz-infrastructure"
dns_tool = "signoz-dns"
ansible_tool = "signoz-ansible"
ansible_local_tool = "signoz-ansible-local"
ROOT = Path(__file__).parent / "resources"
template_opts = PRESERVE_JINJA_DELIMITERS


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="signoz")


def template(path: str, file: str) -> dict:
    name = f"tools/{path}/{file}"
    return {"name": name, "content": (ROOT / name).read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


def cidrs(opts: dict, key: str) -> list[str]:
    value = opts.get(key)
    xs = value if isinstance(value, list) else re.split(
        r"[,\s]+", "" if value is None else str(value))
    return [s for s in (str(x).strip() for x in xs) if s]


def credential_env(opts: dict, *slots: str) -> dict[str, str] | None:
    merged: dict[str, str] = {}
    for slot in [*slots, "provider-backend"]:
        merged.update(validate.tofu_env(opts, slot))
    result = {}
    for key, env_var in merged.items():
        value = "" if opts.get(key) is None else str(opts.get(key))
        if value:
            result[env_var] = value
    return result or None


def backend_credential_env(opts: dict) -> dict[str, str] | None:
    return credential_env(opts)


def fallback_params(opts: dict) -> dict:
    return {"ip": "192.0.2.10", "user": "root", "sudoer": "root",
            "name": opts.get("profile")}


def output_params(result: dict) -> dict | None:
    return (result.get("tofu/outputs") or {}).get("params")


# ---------------------------------------------------------------- compute


def infrastructure_data(opts: dict) -> dict:
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "ssh-sources-hcl": tofu.hcl_list(cidrs(opts, "vultr-ssh-sources")),
            "http-sources-hcl": tofu.hcl_list(cidrs(opts, "vultr-http-sources"))}


async def infrastructure_step(opts: dict) -> dict:
    dir = tool_dir(opts, infrastructure_tool)
    specs = [spec(template("infrastructure", "main.tf"), f"{dir}/main.tf",
                  infrastructure_data(opts))]
    result = await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-compute"))
    if (result.get("blue/exit") or 0) > 0:
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_params(opts)}
    if opts.get("blue/event") == "delete":
        return result
    return {**result, **fallback_params(opts), **(output_params(result) or {})}


# -------------------------------------------------------------------- dns


def zone(opts: dict) -> str | None:
    """The Cloudflare zone the UI host belongs to (its registrable domain)."""
    return registrable_domain(opts.get("signoz-host"))


def dns_json(opts: dict) -> str:
    return tofu.constructs_json([
        tofu.construct("resource", "cloudflare_dns_record", "signoz",
                       {"zone_id": "${data.cloudflare_zone.zone.id}",
                        "name": opts.get("signoz-host"),
                        "content": opts.get("ip"), "type": "A",
                        "proxied": True, "ttl": 1})])


async def dns_step(opts: dict) -> dict:
    dir = tool_dir(opts, dns_tool)
    data = {**opts,
            "ip": opts.get("ip") or fallback_params(opts)["ip"],
            "signoz-zone": zone(opts)}
    specs = [spec(template("dns", "main.tf"), f"{dir}/main.tf", data),
             raw_spec(f"{dir}/record.tf.json", dns_json(data))]
    return await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-dns"))


# ---------------------------------------------------------- ansible (local)


def ansible_local_data(opts: dict) -> dict:
    """Only what a `build` genuinely knows. The address, the user and the alias
    are run-time facts and reach the play as extra-vars instead, so the
    rendered playbook carries no IP and is identical on every workstation (SSH
    Config Standard §6)."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "ssh-config-identity-file": ssh_config.identity_file(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = ansible_local_data(opts)
    return [spec(template("ansible-local", name), f"{dir}/{name}", data)
            for name in ["ansible.cfg", "inventory.ini", "main.yml"]]


async def ansible_local_step(opts: dict) -> dict:
    """Write or remove the `~/.ssh/config` block. The same playbook serves both
    events; `block_state` is what distinguishes them."""
    dir = tool_dir(opts, ansible_local_tool)
    delete = opts.get("blue/event") == "delete"
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=dir, inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={"host_alias": ssh_config.host_alias(opts),
                    "ip": opts.get("ip") or fallback_params(opts)["ip"],
                    "user": opts.get("user") or "root",
                    "block_state": "absent" if delete else "present"})


# ---------------------------------------------------------------- ansible


def _pretty(value, indent=0):
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract."""
    if isinstance(value, list):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k))} : {_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    return json.dumps(value)


def inventory(opts: dict) -> str:
    return _pretty(
        {"all": {"children": {"signoz": {"hosts": {
            opts.get("profile"): {"ansible_host": opts.get("ip") or "192.0.2.10",
                                  "ansible_user": "root"}}}}}})


def ansible_data(opts: dict) -> dict:
    """Template values for the Ansible stage.

    Deliberately carries none of the three operator secrets. They reach the
    host as Ansible `lookup('env', ...)` expressions written literally into
    main.yml, where `preserve-jinja-delimiters` passes them through untouched —
    routing them through this map instead would let the template engine
    HTML-escape the quotes and hand Ansible `&#39;`. The secret therefore
    exists only in the process that needs it: not in `.colors/`, not in a
    golden, not in this map."""
    return {**opts,
            "ip": opts.get("ip") or "192.0.2.10",
            "ssh-keygen": validate.keygen(opts)}


ANSIBLE_FILES = [
    "ansible.cfg", "main.yml", "cleanup.yml", "compose.yml", "Caddyfile",
    "ingester.yaml", "opamp.yaml", "keeper.yaml", "clickhouse.yaml",
    "functions.yaml", "smoke.sh", "backup.sh", "backup.service", "backup.timer",
]


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    data = ansible_data(opts)
    return [*[spec(template("ansible", name), f"{dir}/{name}", data)
              for name in ANSIBLE_FILES],
            raw_spec(f"{dir}/inventory.json", inventory(data))]


async def ansible_step(opts: dict) -> dict:
    dir = tool_dir(opts, ansible_tool)
    if opts.get("blue/event") == "delete" and not opts.get("ip"):
        # No compute in state: there is no host to stop, and the cleanup play
        # would only fail against the placeholder address.
        return {**opts, "blue/exit": 0}
    return await ansible_with_spec(
        opts, ansible_specs(opts),
        dir=dir, inventory="inventory.json",
        playbooks={"create": "main.yml", "delete": "cleanup.yml"},
        host_key_checking=False)


# ------------------------------------------------------------- acceptance


async def wait_for(args: list[str], attempts: int) -> bool:
    """True once `args` exits zero, retrying every five seconds."""
    n = attempts
    while True:
        result = await runtime.exec(args, timeout_ms=20000)
        if result.exit == 0:
            return True
        if n > 0:
            await asyncio.sleep(5)
            n -= 1
        else:
            return False


async def run(args: list[str]):
    return await runtime.exec(args, timeout_ms=20000)


async def http_status(args: list[str]) -> str:
    """The status code a request returns, as a string, or "000" when the
    request never completed."""
    return str((await run(args)).out or "").strip()


async def acceptance_step(opts: dict) -> dict:
    """Public health checks after a real create.

    The end-to-end ingest proof runs on the server, inside the playbook, where
    the generated ingestion token lives. What is checked from here is what the
    internet can reach: the UI over HTTPS, and an OTLP endpoint that refuses an
    unauthenticated write. The refusal is the point — SigNoz community edition
    has no ingestion keys of its own, so an endpoint that accepted this request
    would be an open write path into ClickHouse."""
    if opts.get("blue/event") != "create":
        return {**opts, "blue/exit": 0}
    base = f"https://{opts.get('signoz-host')}"
    if not await wait_for(["curl", "-fsS", "-o", "/dev/null", f"{base}/"], 60):
        return {**opts, "blue/exit": 1,
                "blue/err": "the SigNoz UI did not become reachable over HTTPS"}
    health = await http_status(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         f"{base}/api/v1/health"])
    otlp = await http_status(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "-X", "POST", "-H", "content-type: application/json",
         "--data", '{"resourceLogs":[]}', f"{base}/v1/logs"])
    if health != "200":
        return {**opts, "blue/exit": 1,
                "blue/err": f"the SigNoz API is not healthy: /api/v1/health returned {health}"}
    if otlp != "401":
        return {**opts, "blue/exit": 1,
                "blue/err": ("the public OTLP endpoint is not gated: an unauthenticated "
                             f"/v1/logs returned {otlp} rather than 401")}
    return {**opts, "blue/exit": 0,
            "signoz/acceptance": {"ui": "ok", "health": health,
                                  "otlp-unauthenticated": otlp}}
