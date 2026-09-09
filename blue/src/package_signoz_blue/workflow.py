"""The graph, the port of io.github.getcolors.signoz.workflow."""

from __future__ import annotations

import os

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow
from . import compute

from . import ssh, ssh_config, tools, validate

DEFAULTS = {"provider-compute": validate.default_compute_provider,
            "provider-dns": "cloudflare",
            "provider-backend": "r2", "compute-prevent-destroy": True,
            "workdir": ".colors"}


async def start_step(original, env=None):
    async def after(opts, environment, ctx):
        if ctx['real'] and ctx['event'] == 'delete':
            return await compute.load(opts, environment)
        if ctx['real'] and ctx['event'] == 'create':
            return ssh_config.preflight(opts)
        return {**ssh.with_machine_key(opts), 'blue/exit': 0}
    return await preflight(original, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[lambda _o,e,_c: validate.env_errors(e), lambda o,_e,_c: validate.state_errors(o),
                    lambda o,_e,c: validate.secret_errors(o,c['event']) if c['real'] and c['event'] in ('create','delete') else [],
                    lambda o,_e,c: ['compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false to delete'] if c['real'] and c['event']=='delete' and o.get('compute-prevent-destroy') else []], after_validate=after)


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "signoz/start": (start_step, "signoz/ansible"),
            "signoz/ansible": (tools.ansible_step, "signoz/dns"),
            # The `~/.ssh/config` block goes before the destroy, the opposite
            # of the keypair below. A block that outlives its host is stale but
            # harmless; a key that predeceases its host locks the operator out
            # of a machine that still exists. Both orders are deliberate; see
            # standards/ssh-config.md.
            "signoz/dns": (tools.dns_step, "signoz/ssh-config"),
            "signoz/ssh-config": (tools.ansible_local_step, "signoz/infrastructure"),
            "signoz/infrastructure": (tools.infrastructure_step,),
        }.get(step)
    return {
        "signoz/start": (start_step, "signoz/infrastructure"),
        # After compute, which is where the address first exists, and before
        # the stage that converges the machine.
        "signoz/infrastructure": (tools.infrastructure_step, "signoz/ssh-config"),
        "signoz/ssh-config": (tools.ansible_local_step, "signoz/dns"),
        "signoz/dns": (tools.dns_step, "signoz/ansible"),
        "signoz/ansible": (tools.ansible_step, "signoz/acceptance"),
        "signoz/acceptance": (tools.acceptance_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tools.tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile') or ''}/{tool}.tfstate")


side_effecting = ["signoz/infrastructure", "signoz/dns", "signoz/ssh-config",
                  "signoz/ansible", "signoz/acceptance"]


def create_workflow():
    wf = workflow(start="signoz/start", wire_fn=wire_fn, next_fn=lambda _step, successors, opts: [] if opts.get("signoz/already-destroyed") or failed(opts) else [(step, opts) for step in (successors or [])])
    wf = advice_add(wf, "signoz/dns", "before", "signoz.workflow/backend",
                    backend_advice(tools.dns_tool))
    return dry_run.advise(progress.advise(wf), side_effecting)


signoz_workflow = create_workflow()
