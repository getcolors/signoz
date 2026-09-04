import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { failed } from "red/workflow";
import { registrableDomain } from "package-once-red";
import * as sshConfig from "./ssh-config.ts";
import * as validate from "./validate.ts";

import ansibleLocalCfg from "../resources/tools/ansible-local/ansible.cfg" with { type: "text" };
import ansibleLocalInventory from "../resources/tools/ansible-local/inventory.ini" with { type: "text" };
import ansibleLocalMain from "../resources/tools/ansible-local/main.yml" with { type: "text" };
import ansibleCfg from "../resources/tools/ansible/ansible.cfg" with { type: "text" };
import ansibleMain from "../resources/tools/ansible/main.yml" with { type: "text" };
import ansibleCleanup from "../resources/tools/ansible/cleanup.yml" with { type: "text" };
import ansibleCompose from "../resources/tools/ansible/compose.yml" with { type: "text" };
import ansibleCaddyfile from "../resources/tools/ansible/Caddyfile" with { type: "text" };
import ansibleIngester from "../resources/tools/ansible/ingester.yaml" with { type: "text" };
import ansibleOpamp from "../resources/tools/ansible/opamp.yaml" with { type: "text" };
import ansibleKeeper from "../resources/tools/ansible/keeper.yaml" with { type: "text" };
import ansibleClickhouse from "../resources/tools/ansible/clickhouse.yaml" with { type: "text" };
import ansibleFunctions from "../resources/tools/ansible/functions.yaml" with { type: "text" };
import ansibleSmoke from "../resources/tools/ansible/smoke.sh" with { type: "text" };
import ansibleBackupSh from "../resources/tools/ansible/backup.sh" with { type: "text" };
import ansibleBackupService from "../resources/tools/ansible/backup.service" with { type: "text" };
import ansibleBackupTimer from "../resources/tools/ansible/backup.timer" with { type: "text" };
import dnsMainTf from "../resources/tools/dns/main.tf" with { type: "text" };
import infrastructureDigitaloceanTf from "../resources/tools/infrastructure/digitalocean/main.tf" with { type: "text" };
import infrastructureVultrTf from "../resources/tools/infrastructure/vultr/main.tf" with { type: "text" };

export const infrastructureTool = "signoz-infrastructure";
export const dnsTool = "signoz-dns";
export const ansibleTool = "signoz-ansible";
export const ansibleLocalTool = "signoz-ansible-local";
export const templateOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "signoz" });
}

// The template tree this colour carries, keyed the way green names its
// classpath resources: "<path>/<file>" with dots as directories.
const templates: Record<string, string> = {
  "ansible-local/ansible.cfg": ansibleLocalCfg,
  "ansible-local/inventory.ini": ansibleLocalInventory,
  "ansible-local/main.yml": ansibleLocalMain,
  "ansible/ansible.cfg": ansibleCfg,
  "ansible/main.yml": ansibleMain,
  "ansible/cleanup.yml": ansibleCleanup,
  "ansible/compose.yml": ansibleCompose,
  "ansible/Caddyfile": ansibleCaddyfile,
  "ansible/ingester.yaml": ansibleIngester,
  "ansible/opamp.yaml": ansibleOpamp,
  "ansible/keeper.yaml": ansibleKeeper,
  "ansible/clickhouse.yaml": ansibleClickhouse,
  "ansible/functions.yaml": ansibleFunctions,
  "ansible/smoke.sh": ansibleSmoke,
  "ansible/backup.sh": ansibleBackupSh,
  "ansible/backup.service": ansibleBackupService,
  "ansible/backup.timer": ansibleBackupTimer,
  "dns/main.tf": dnsMainTf,
  "infrastructure/digitalocean/main.tf": infrastructureDigitaloceanTf,
  "infrastructure/vultr/main.tf": infrastructureVultrTf,
};

export function template(path: string, file: string): Template {
  const name = `${path.replaceAll(".", "/")}/${file}`;
  const content = templates[name];
  if (content === undefined) throw new Error(`template not found: ${name}`);
  return { name, content };
}

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
}

const rawSpec = (target: string, content: string): Spec => contentSpec(target, content);

// The source lists as validate parses them, so the template and the
// validator can never disagree about what an entry is.
export const cidrs = validate.cidrs;

export function credentialEnv(opts: Opts, ...slots: string[]): Record<string, string> | undefined {
  const mapping: Record<string, string> = Object.assign(
    {},
    ...[...slots, "provider-backend"].map((slot) => validate.tofuEnv(opts, slot)),
  );
  const env: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(mapping)) {
    const value = String(opts[key] ?? "");
    if (value.length > 0) env[envVar] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export const backendCredentialEnv = (opts: Opts) => credentialEnv(opts);

// What `build` and `--dry-run` render in place of a compute output: the
// documentation address, shaped like the selected provider's real `params` so
// every later stage sees the same keys either way.
export function fallbackParams(opts: Opts): Record<string, unknown> {
  return { provider: opts["provider-compute"], ip: "192.0.2.10", user: "root", sudoer: "root",
    name: validate.computeName(opts) };
}

export function outputParams(result: Opts): Record<string, unknown> | undefined {
  const params = (result["tofu/outputs"] as Record<string, unknown> | undefined)?.params;
  return params && typeof params === "object" ? params as Record<string, unknown> : undefined;
}

// Refuse to hand 192.0.2.10 to Ansible. That is the documentation address the
// credential-free build and dry-run paths render with; on a real converge a
// missing compute output must fail loudly rather than quietly point the whole
// playbook at TEST-NET.
export function resolvedCompute(
  result: Opts,
  fallback: Record<string, unknown>,
  outputs: Record<string, unknown> | undefined,
): Opts {
  if (outputs?.ip) return { ...result, ...fallback, ...outputs };
  return { ...result, "red/exit": 1,
    "red/err": "compute produced no ip output; refusing to converge against the documentation address" };
}

// ---------------------------------------------------------------- compute

// Template values for the compute stage. The name and the source lists are
// resolved here once, so a template interpolates values and never branches on
// which provider it belongs to.
export function infrastructureData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "compute-name": validate.computeName(opts),
    "ssh-sources-hcl": tofu.hclList(cidrs(opts, validate.computeKey(opts, "ssh-sources"))),
    "http-sources-hcl": tofu.hclList(cidrs(opts, validate.computeKey(opts, "http-sources"))),
  };
}

// Providers are selected by template directory, `infrastructure/<provider>/`,
// not by conditionals inside one file; the rendered target is the same
// `main.tf` whichever directory it came from.
export function infrastructureTemplate(opts: Opts): Template {
  return template(`infrastructure.${opts["provider-compute"]}`, "main.tf");
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const specs = [spec(infrastructureTemplate(opts), `${dir}/main.tf`, infrastructureData(opts))];
  const result = await tofu.tofuWithSpec(opts, specs,
    { dir, env: credentialEnv(opts, "provider-compute") });
  if (failed(result)) return result;
  if (opts["red/event"] === "build") return { ...result, ...fallbackParams(opts) };
  if (opts["red/event"] === "delete") return result;
  return resolvedCompute(result, fallbackParams(opts), outputParams(result));
}

// -------------------------------------------------------------------- dns

// The Cloudflare zone the UI host belongs to (its registrable domain).
export function zone(opts: Opts): string | undefined {
  return registrableDomain(opts["signoz-host"]);
}

export function dnsJson(opts: Opts): string {
  return tofu.constructsJson([
    tofu.construct("resource", "cloudflare_dns_record", "signoz", {
      zone_id: "${data.cloudflare_zone.zone.id}",
      name: opts["signoz-host"], content: opts.ip, type: "A",
      proxied: true, ttl: 1,
    }),
  ]);
}

export async function dnsStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, dnsTool);
  const data: Opts = {
    ...opts,
    ip: opts.ip ?? fallbackParams(opts).ip,
    "signoz-zone": zone(opts),
  };
  const specs = [
    spec(template("dns", "main.tf"), `${dir}/main.tf`, data),
    rawSpec(`${dir}/record.tf.json`, dnsJson(data)),
  ];
  return tofu.tofuWithSpec(opts, specs, { dir, env: credentialEnv(opts, "provider-dns") });
}

// ---------------------------------------------------------- ansible (local)

// Only what a `build` genuinely knows. The address, the user and the alias are
// run-time facts and reach the play as extra-vars instead, so the rendered
// playbook carries no IP and is identical on every workstation (SSH Config
// Standard §6).
export function ansibleLocalData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "ssh-config-identity-file": sshConfig.identityFile(opts),
  };
}

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = ansibleLocalData(opts);
  return [
    spec(template("ansible-local", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(template("ansible-local", "inventory.ini"), `${dir}/inventory.ini`, data),
    spec(template("ansible-local", "main.yml"), `${dir}/main.yml`, data),
  ];
}

// Write or remove the `~/.ssh/config` block. The same playbook serves both
// events; `block_state` is what distinguishes them.
export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleLocalTool);
  const isDelete = opts["red/event"] === "delete";
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: {
      host_alias: sshConfig.hostAlias(opts),
      ip: opts.ip ?? fallbackParams(opts).ip,
      user: opts.user ?? "root",
      block_state: isDelete ? "absent" : "present",
    },
  }, ansibleLocalSpecs(opts));
}

// ---------------------------------------------------------------- ansible

function pretty(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => pretty(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${pretty(nested, indent + 2)}`)
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  return JSON.stringify(value ?? null);
}

export function inventory(opts: Opts): string {
  return pretty({
    all: {
      children: {
        signoz: {
          hosts: {
            [String(opts.profile)]: {
              ansible_host: opts.ip ?? "192.0.2.10",
              ansible_user: "root",
            },
          },
        },
      },
    },
  });
}

// Template values for the Ansible stage.
//
// Deliberately carries none of the three operator secrets. They reach the host
// as Ansible `lookup('env', ...)` expressions written literally into main.yml,
// where `preserve-jinja-delimiters` passes them through untouched — routing
// them through this map instead would let the template engine HTML-escape the
// quotes and hand Ansible `&#39;`. The secret therefore exists only in the
// process that needs it: not in `.colors/`, not in a golden, not in this map.
export function ansibleData(opts: Opts): Opts {
  return {
    ...opts,
    ip: opts.ip ?? "192.0.2.10",
    "ssh-keygen": validate.keygen(opts),
  };
}

export function ansibleSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleTool);
  const data = ansibleData(opts);
  const files = ["ansible.cfg", "main.yml", "cleanup.yml", "compose.yml", "Caddyfile",
                 "ingester.yaml", "opamp.yaml", "keeper.yaml", "clickhouse.yaml",
                 "functions.yaml", "smoke.sh", "backup.sh", "backup.service", "backup.timer"];
  return [
    ...files.map((name) => spec(template("ansible", name), `${dir}/${name}`, data)),
    rawSpec(`${dir}/inventory.json`, inventory(data)),
  ];
}

export async function ansibleStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleTool);
  if (opts["red/event"] === "delete" && !opts.ip) {
    // No compute in state: there is no host to stop, and the cleanup play
    // would only fail against the placeholder address.
    return { ...opts, "red/exit": 0 };
  }
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.json",
    playbooks: { create: "main.yml", delete: "cleanup.yml" },
    hostKeyChecking: false,
  }, ansibleSpecs(opts));
}

// ------------------------------------------------------------- acceptance

async function run(args: string[]) {
  return runtime.exec(args, { timeoutMs: 20000 });
}

// True once `args` exits zero, retrying every five seconds.
export async function waitFor(args: string[], attempts: number): Promise<boolean> {
  for (let remaining = attempts; ; remaining -= 1) {
    const result = await run(args);
    if (result.exit === 0) return true;
    if (remaining <= 0) return false;
    await Bun.sleep(5000);
  }
}

// The status code a request returns, as a string, or "000" when the request
// never completed.
export async function httpStatus(args: string[]): Promise<string> {
  return String((await run(args)).out ?? "").trim();
}

// Public health checks after a real create.
//
// The end-to-end ingest proof runs on the server, inside the playbook, where
// the generated ingestion token lives. What is checked from here is what the
// internet can reach: the UI over HTTPS, and an OTLP endpoint that refuses an
// unauthenticated write. The refusal is the point — SigNoz community edition
// has no ingestion keys of its own, so an endpoint that accepted this request
// would be an open write path into ClickHouse.
export async function acceptanceStep(opts: Opts): Promise<Opts> {
  if (opts["red/event"] !== "create") return { ...opts, "red/exit": 0 };
  const base = `https://${opts["signoz-host"]}`;
  if (!(await waitFor(["curl", "-fsS", "-o", "/dev/null", `${base}/`], 60))) {
    return { ...opts, "red/exit": 1,
      "red/err": "the SigNoz UI did not become reachable over HTTPS" };
  }
  const health = await httpStatus([
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    `${base}/api/v1/health`,
  ]);
  const otlp = await httpStatus([
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "-X", "POST", "-H", "content-type: application/json",
    "--data", '{"resourceLogs":[]}', `${base}/v1/logs`,
  ]);
  if (health !== "200") {
    return { ...opts, "red/exit": 1,
      "red/err": `the SigNoz API is not healthy: /api/v1/health returned ${health}` };
  }
  if (otlp !== "401") {
    return { ...opts, "red/exit": 1,
      "red/err": "the public OTLP endpoint is not gated: an unauthenticated " +
        `/v1/logs returned ${otlp} rather than 401` };
  }
  return { ...opts, "red/exit": 0,
    "signoz/acceptance": { ui: "ok", health, "otlp-unauthenticated": otlp } };
}
