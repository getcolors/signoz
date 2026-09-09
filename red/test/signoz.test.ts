import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StepError, type Opts } from "red/workflow";
import * as ssh from "../src/ssh.ts";
import * as sshConfig from "../src/ssh-config.ts";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
import * as compute from "../src/compute.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const optoutFile = join(import.meta.dir, "../../test/fixtures/optout.yml");
const doFixtureFile = join(import.meta.dir, "../../test/fixtures/colors-digitalocean.yml");
const doOptoutFile = join(import.meta.dir, "../../test/fixtures/optout-digitalocean.yml");

function readFixture(path: string, overrides: Opts): Opts {
  const text = readFileSync(path, "utf8").replaceAll("WORKDIR", ".colors");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}

const fixture = (overrides: Opts = {}) => readFixture(fixtureFile, overrides);
const optout = (overrides: Opts = {}) => readFixture(optoutFile, overrides);
const doFixture = (overrides: Opts = {}) => readFixture(doFixtureFile, overrides);
const doOptout = (overrides: Opts = {}) => readFixture(doOptoutFile, overrides);

// ~/.ssh redirection: ONCE's ssh module and this package's ssh-config both
// read $HOME at call time, exactly so tests can point them at a fresh
// temporary home.
let savedHome: string | undefined;
let home: string;
beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "signoz-red-test"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// --- desired state -----------------------------------------------------------

describe("validate", () => {
  test("all four fixtures are valid", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
    expect(validate.stateErrors(optout())).toEqual([]);
    expect(validate.stateErrors(doFixture())).toEqual([]);
    expect(validate.stateErrors(doOptout())).toEqual([]);
  });

  // --- the spec handed to ONCE


  // --- the compute-provider registry


  test("name and machine key are never required", () => {
    for (const errors of [validate.stateErrors(fixture({ "vultr-name": null })),
                          validate.stateErrors(doFixture())]) {
      expect(errors.some((e) => e.includes("-name"))).toBe(false);
      expect(errors.some((e) => e.includes("-ssh-keys"))).toBe(false);
    }
  });

  // --- the compute name


  // --- the network contract


  test("the machine key is not required", () => {
    // The standard makes absence meaningful: requiring vultr-ssh-keys would
    // make every conforming keygen deployment invalid.
    expect(validate.stateErrors(fixture()).some((e) => e.includes("vultr-ssh-keys"))).toBe(false);
  });

  test("absent machine key selects keygen", () => {
    expect(validate.keygen(fixture())).toBe(true);
    expect(validate.keygen(optout())).toBe(false);
  });

  test("reports all errors at once", () => {
    const errors = validate.stateErrors(fixture({
      "signoz-host": "bad",
      "signoz-image": "floating",
      "signoz-root-email": "not-an-email",
      "provider-dns": "other", "provider-compute": "hetzner",
      "signoz-backup-retention-days": 0,
      "signoz-backup-dir": "relative/path",
    }));
    expect(errors.length).toBeGreaterThanOrEqual(7);
    for (const part of ["host", "image", "root-email", "provider-dns", "compute deployment",
                        "retention-days", "backup-dir"]) {
      expect(errors.some((e) => e.includes(part))).toBe(true);
    }
  });

  test("accepts a digest pin", () => {
    expect(validate.stateErrors(
      fixture({ "signoz-caddy-image": `caddy@sha256:${"a".repeat(64)}` }))).toEqual([]);
  });

  test("the application and collector may not float", () => {
    // They version independently upstream and share a schema, so nothing can
    // check the pair is compatible. What can be checked is that neither moves
    // on its own between converges.
    for (const key of ["signoz-image", "signoz-collector-image"]) {
      const errors = validate.stateErrors(fixture({ [key]: "signoz/signoz:latest" }));
      expect(errors.some((e) => e.includes("floating tag"))).toBe(true);
    }
  });

  test("profile overlay is refused", () => {
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "other" }).length).toBe(1);
    expect(validate.envErrors({})).toEqual([]);
  });

  test("a create names every package secret", () => {
    const errors = validate.secretErrors(fixture(), "create").join("\n");
    for (const name of ["COLORS_PAR_CLOUDFLARE_API_TOKEN",
                        "COLORS_PAR_SIGNOZ_ROOT_PASSWORD",
                        "COLORS_PAR_SIGNOZ_BACKUP_R2_ACCESS_KEY_ID",
                        "COLORS_PAR_SIGNOZ_BACKUP_R2_SECRET_ACCESS_KEY"]) {
      expect(errors).toContain(name);
    }
    // Both are generated on the server and never supplied by the operator.
    expect(errors).not.toContain("INGEST");
    expect(errors).not.toContain("POSTGRES");
    expect(errors).not.toContain("COLORS_PAR_DO_TOKEN");
  });


  test("a delete asks only for the providers", () => {
    // Destroying a machine must not require the credentials needed to converge
    // one; a missing root password should not be a lock on the exit.
    const errors = validate.secretErrors(fixture(), "delete").join("\n");
    expect(errors).toContain("COLORS_PAR_CLOUDFLARE_API_TOKEN");
    expect(errors).not.toContain("COLORS_PAR_SIGNOZ_ROOT_PASSWORD");
    expect(errors).not.toContain("BACKUP");
  });
});

// --- tools -------------------------------------------------------------------

describe("tools", () => {


  test("library node params feed downstream steps",()=>{
    const p=tools.fallbackParams(fixture());expect(p.node_id).toBe('0');expect(p.vpc_ip).toBeNull();expect(p.name).toBe('signoz-fixture');
    expect(tools.inventory(fixture({ip:'203.0.113.7',user:'ubuntu'}))).toContain('ubuntu');
  });


  test("dns zone is the registrable domain", () => {
    expect(tools.zone(fixture())).toBe("example.com");
  });

  test("dns record is the host, proxied", () => {
    const json = tools.dnsJson(fixture({ ip: "192.0.2.10" }));
    expect(json).toContain("signoz.example.com");
    expect(json).toContain("192.0.2.10");
    expect(json).toContain("proxied");
  });

  test("the inventory keeps one target", () => {
    const inventory = tools.inventory(fixture({ ip: "192.0.2.10" }));
    expect(inventory).toContain("192.0.2.10");
    expect(inventory).toContain("signoz-fixture");
  });

  test("the ansible stage renders the whole stack", () => {
    const targets = tools.ansibleSpecs(fixture()).map((s) => String(s.target));
    for (const file of ["ansible.cfg", "main.yml", "cleanup.yml", "compose.yml", "Caddyfile",
                        "ingester.yaml", "opamp.yaml", "keeper.yaml", "clickhouse.yaml",
                        "functions.yaml", "smoke.sh", "backup.sh", "backup.service",
                        "backup.timer", "inventory.json"]) {
      expect(targets.some((t) => t.endsWith(file))).toBe(true);
    }
  });

  test("operator secrets reach the host as lookups, not values", () => {
    // `.colors/` is generated output and the goldens are committed, so the
    // secret must never be the thing that lands on disk — the expression is.
    // The lookups live literally in the template rather than in the data map,
    // because the template engine HTML-escapes a value it interpolates and
    // Ansible would receive `&#39;` instead of a quote.
    const template = readFileSync(
      join(import.meta.dir, "../resources/tools/ansible/main.yml"), "utf8");
    for (const par of ["COLORS_PAR_SIGNOZ_ROOT_PASSWORD",
                       "COLORS_PAR_SIGNOZ_BACKUP_R2_ACCESS_KEY_ID",
                       "COLORS_PAR_SIGNOZ_BACKUP_R2_SECRET_ACCESS_KEY"]) {
      expect(template).toContain(`lookup('env','${par}')`);
    }
  });

  test("the data map carries no operator secret", () => {
    const spec = tools.ansibleSpecs(fixture())
      .find((s) => String(s.target).endsWith("main.yml"));
    const data = (spec?.data ?? {}) as Opts;
    expect(data["signoz-root-email"]).toBe("admin@signoz.example.com");
    for (const key of ["signoz-root-password", "signoz-backup-access-key",
                       "signoz-backup-secret-key"]) {
      expect(data[key]).toBeUndefined();
    }
  });

  test("a delete without owned compute refuses the host step",async()=>{
    const r=await tools.ansibleStep(fixture({'red/event':'delete'}));expect(r['red/exit']).toBe(1);expect(r['red/err']).toBe('compute node unavailable');
  });

  test("acceptance is skipped outside a real create", async () => {
    for (const event of ["build", "delete"]) {
      const result = await tools.acceptanceStep(fixture({ "red/event": event }));
      expect(result["red/exit"]).toBe(0);
    }
  });

  test("tool dirs live under <workdir>/<profile>", () => {
    const opts = { workdir: "/work", profile: "signoz-fixture" };
    expect(tools.toolDir(opts, tools.infrastructureTool))
      .toBe("/work/signoz-fixture/signoz-infrastructure");
    expect(tools.toolDir(opts, tools.ansibleLocalTool))
      .toBe("/work/signoz-fixture/signoz-ansible-local");
  });

  test("backend advice writes the conventional state address", () => {
    const work = mkdtempSync(join(tmpdir(), "signoz-red-backend"));
    try {
      const opts = fixture({ workdir: work, "provider-backend": "r2" });
      workflow.backendAdvice(tools.dnsTool)(opts);
      const backend = JSON.parse(readFileSync(
        join(work, "signoz-fixture", "signoz-dns", "backend.tf.json"), "utf8"));
      const s3 = backend.terraform.backend.s3;
      expect(s3.bucket).toBe("tofu-state-example");
      expect(s3.key).toBe("signoz-fixture/signoz-dns.tfstate");
      expect(s3.endpoints.s3).toBe("https://example.eu.r2.cloudflarestorage.com");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

// --- ssh keypair (SSH Keypair Standard) --------------------------------------

describe("ssh-config", () => {
  test("the alias is the profile and the identity file keeps the tilde", () => {
    expect(sshConfig.hostAlias(fixture())).toBe("signoz-fixture");
    expect(sshConfig.identityFile(fixture())).toBe("~/.ssh/signoz-fixture");
    expect(sshConfig.identityFile(fixture())).not.toContain(home);
  });

  test("the marker is the alias alone", () => {
    expect(sshConfig.beginMarker("signoz-vultr")).toBe("# BEGIN signoz-vultr ANSIBLE MANAGED BLOCK");
    expect(sshConfig.endMarker("signoz-vultr")).toBe("# END signoz-vultr ANSIBLE MANAGED BLOCK");
  });

  test("a foreign stanza is found; our own block is not foreign", () => {
    expect(sshConfig.foreignStanzaLine(
      ["Host other", "    HostName 192.0.2.1", "", "Host signoz-fixture"],
      "signoz-fixture")).toBe(4);
    const alias = "signoz-fixture";
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, "    HostName 192.0.2.1",
       sshConfig.endMarker(alias)], alias)).toBeUndefined();
  });

  test("a stanza after our block is still foreign", () => {
    const alias = "signoz-fixture";
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, sshConfig.endMarker(alias),
       `Host ${alias}`], alias)).toBe(4);
  });

  test("a block under a retired marker is foreign", () => {
    const alias = "signoz-vultr";
    expect(sshConfig.foreignStanzaLine(
      [`# BEGIN signoz ${alias} ANSIBLE MANAGED BLOCK`, `Host ${alias}`,
       `# END signoz ${alias} ANSIBLE MANAGED BLOCK`], alias)).toBe(2);
  });

  test("multi-pattern host lines count; unrelated files are left alone", () => {
    expect(sshConfig.foreignStanzaLine(["Host web signoz-fixture db"], "signoz-fixture")).toBe(1);
    expect(sshConfig.foreignStanzaLine(["Host build", "Host signoz-other"], "signoz-fixture"))
      .toBeUndefined();
  });

  test("an option above the first Host is refused; comments and Host openers are fine", () => {
    expect(sshConfig.leadingOptionLine(["ServerAliveInterval 60", "Host a"])).toBe(1);
    expect(sshConfig.leadingOptionLine(["# comment", "", "IdentitiesOnly yes", "Host a"])).toBe(3);
    expect(sshConfig.leadingOptionLine(["Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# lead comment", "", "Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["Match host b", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# nothing here", ""])).toBeUndefined();
  });

  test("preflight refuses rather than overwrites", () => {
    const refused = sshConfig.preflight(fixture(), {
      adoptError: () => "already declares `Host x`",
      placementError: () => undefined,
    });
    expect(refused["red/exit"]).toBe(1);
    expect(String(refused["red/err"])).toContain("already declares");
    const clean = sshConfig.preflight(fixture(), {
      adoptError: () => undefined,
      placementError: () => undefined,
    });
    expect(clean["red/exit"]).toBeUndefined();
  });

  test("adopt and placement errors read the real file and mention the recovery", () => {
    write(join(home, ".ssh", "config"), "ServerAliveInterval 60\nHost signoz-fixture\n");
    expect(String(sshConfig.adoptError(fixture()))).toContain("Host signoz-fixture");
    expect(String(sshConfig.placementError(fixture()))).toContain("Host *");
  });

  test("the local play renders no address and follows keygen mode", () => {
    const data = tools.ansibleLocalData(fixture({ ip: "203.0.113.7" }));
    expect(data["ssh-config-identity-file"]).toBe("~/.ssh/signoz-fixture");
    expect(data["ssh-keygen"]).toBe(true);
    expect(tools.ansibleLocalData(optout())["ssh-keygen"]).toBe(false);
  });

  test("the local stage renders three files", () => {
    const targets = tools.ansibleLocalSpecs(fixture()).map((s) => String(s.target));
    for (const file of ["/ansible.cfg", "/inventory.ini", "/main.yml"]) {
      expect(targets.some((t) => t.endsWith(file))).toBe(true);
    }
    expect(targets.every((t) => t.includes("signoz-ansible-local"))).toBe(true);
  });
});

// --- workflow ----------------------------------------------------------------

describe("library compute", () => {
  test("all fixtures validate and use one library node", () => {
    for(const f of [fixture,optout,doFixture,doOptout]) expect(validate.stateErrors(f())).toEqual([]);
    expect(compute.topology).toEqual([{role:null,count:1}]);
    expect(compute.requirements(fixture()).legacy_state_keys).toEqual(['signoz-fixture/signoz-infrastructure.tfstate']);
  });
  test("invalid compute inputs fail before execution", () => {
    for(const update of [{'provider-compute':'unsupported'},{'vultr-plan':null},{'vultr-ssh-sources':[]},{'vultr-http-sources':['bad']}]) expect(validate.stateErrors(fixture(update)).length).toBeGreaterThan(0);
  });
  test("compute credentials are deferred to library state inspection", () => {
    const errors=validate.secretErrors(fixture(),"create").join('\n');
    expect(errors).toContain('COLORS_PAR_CLOUDFLARE_API_TOKEN');
    expect(errors).not.toContain('COLORS_PAR_VULTR_API_KEY');
    expect(validate.tofuEnv(fixture(),'provider-compute')).toEqual({});
  });
  test("failed lifecycle diagnostics and observed node identity survive", () => {
    expect(compute.attach(fixture(),{status:'error',errors:['legacy compute state requires migration']})['red/err']).toBe('legacy compute state requires migration');
    const result=compute.attach(fixture(),{status:'present',cluster:{nodes:[{ip:'203.0.113.7',user:'ubuntu'}]},key:{private_key_path:'/tmp/explicit'}});
    expect(result.user).toBe('ubuntu');expect(result['ssh-private-key-path']).toBe('/tmp/explicit');
    expect(compute.attach(fixture(),{status:'destroyed'})['signoz/already-destroyed']).toBe(true);
    expect(()=>compute.node({cluster:{nodes:[]}})).toThrow();
  });
  test("offline start needs no credentials", async()=> {
    for(const f of [fixture,optout,doFixture,doOptout]) expect((await workflow.startStep(f({'red/event':'build'}),{}))['red/exit']).toBe(0);
  });
  test("managed build and external SSH identities are deterministic",()=> {
    expect(ssh.withMachineKey(fixture({'red/event':'build'}))['ssh-private-key-path']).toBe('/home/build-placeholder/.ssh/signoz-fixture');
    expect(ssh.withMachineKey(optout({'red/event':'build'}))).toEqual(optout({'red/event':'build'}));
    expect(ssh.identityArgs(optout())[1]).toBe('/home/build-placeholder/.ssh/operator-key');
  });
});
