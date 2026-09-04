import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Opts } from "red/workflow";
import * as ssh from "../src/ssh.ts";
import * as sshConfig from "../src/ssh-config.ts";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
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

  // --- the compute-provider registry

  test("an unsupported provider names the advertised ones", () => {
    expect(validate.stateErrors(fixture({ "provider-compute": "hetzner" })))
      .toContain(":provider-compute must be one of digitalocean, vultr");
  });

  test("required keys follow the selected provider", () => {
    expect(validate.stateErrors(doFixture({ "digitalocean-size": null })))
      .toContain(":digitalocean-size is required");
    expect(validate.stateErrors(fixture({ "vultr-plan": null })))
      .toContain(":vultr-plan is required");
    // The other provider's keys are neither required nor refused, so one
    // colors.yml can carry both and move between providers by one edit.
    expect(validate.stateErrors(doFixture()).some((e) => e.includes("vultr"))).toBe(false);
    expect(validate.stateErrors(fixture({ "digitalocean-region": "ams3",
      "digitalocean-size": "s-1vcpu-1gb" }))).toEqual([]);
    expect(validate.stateErrors(doFixture({ "vultr-os-id": "not-checked-here" }))).toEqual([]);
  });

  test("name and machine key are never required", () => {
    for (const errors of [validate.stateErrors(fixture({ "vultr-name": null })),
                          validate.stateErrors(doFixture())]) {
      expect(errors.some((e) => e.includes("-name"))).toBe(false);
      expect(errors.some((e) => e.includes("-ssh-keys"))).toBe(false);
    }
  });

  test("vultr-os-id is checked on Vultr only", () => {
    expect(validate.stateErrors(fixture({ "vultr-os-id": "2284" })))
      .toContain(":vultr-os-id must be Vultr's numeric operating-system id");
    expect(validate.stateErrors(doFixture({ "vultr-os-id": "2284" }))).toEqual([]);
  });

  test("DigitalOcean refuses a pinned or created VPC", () => {
    const errors = validate.stateErrors(doFixture({ "digitalocean-vpc-uuid": "abc",
      "digitalocean-vpc-cidr": "10.0.0.0/16" }));
    expect(errors.some((e) => e.startsWith(":digitalocean-vpc-uuid must be absent"))).toBe(true);
    expect(errors.some((e) => e.startsWith(":digitalocean-vpc-cidr must be absent"))).toBe(true);
    // An unselected provider's keys are ignored, VPC keys included.
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-uuid": "abc" }))).toEqual([]);
  });

  // --- the compute name

  test("compute name falls back to the profile", () => {
    expect(validate.computeName(doFixture())).toBe("signoz-digitalocean-fixture");
    expect(validate.computeName(doOptout())).toBe("signoz-digitalocean-optout");
    expect(validate.computeName(fixture({ "vultr-name": null }))).toBe("signoz-fixture");
    expect(validate.computeName(fixture({ "vultr-name": "" }))).toBe("signoz-fixture");
    expect(validate.computeName(fixture({ "vultr-name": "REPLACE_ME" }))).toBe("signoz-fixture");
    expect(validate.computeName(fixture({ "vultr-name": "custom-label" }))).toBe("custom-label");
    // The override is read from the selected provider's key alone.
    expect(validate.computeName(doFixture({ "vultr-name": "custom-label" })))
      .toBe("signoz-digitalocean-fixture");
  });

  test("the name override is validated against the provider's rules", () => {
    expect(validate.stateErrors(fixture({ "vultr-name": "no spaces!" })))
      .toContain(":vultr-name must be a safe 1-63 character name");
    expect(validate.stateErrors(fixture({ "vultr-name": "a".repeat(64) })))
      .toContain(":vultr-name must be a safe 1-63 character name");
    // Vultr labels are console text; DigitalOcean droplet names are
    // hostnames, so an underscore that Vultr accepts fails at DigitalOcean.
    expect(validate.stateErrors(fixture({ "vultr-name": "invalid_name" }))).toEqual([]);
    const err = ":digitalocean-name must be a hostname-like name: lowercase letters, digits, dots and hyphens, 1-63 characters";
    for (const bad of ["invalid_name", "Upper", "-leading", "a".repeat(64)]) {
      expect(validate.stateErrors(doFixture({ "digitalocean-name": bad }))).toContain(err);
    }
    expect(validate.stateErrors(doFixture({ "digitalocean-name": "sig.noz-01" }))).toEqual([]);
  });

  test("the resolved name is validated when it falls back to the profile", () => {
    // The profile reaches the provider as the machine name whenever no
    // override is set, so it is held to the same rule and the error names it.
    const errors = validate.stateErrors(doFixture({ profile: "Prod_Name" }));
    expect(errors).toContain(":profile (the digitalocean machine name) must be a hostname-like name: lowercase letters, digits, dots and hyphens, 1-63 characters");
    expect(errors.some((e) => e.includes(":digitalocean-name"))).toBe(false);
    // Vultr's rule allows the same profile.
    expect(validate.stateErrors(fixture({ profile: "Prod_Name", "vultr-name": null }))).toEqual([]);
    // A valid override shadows an invalid profile; an invalid override is the
    // override's error, not the profile's.
    expect(validate.stateErrors(doFixture({ profile: "Prod_Name", "digitalocean-name": "prod" }))).toEqual([]);
    expect(validate.stateErrors(doFixture({ profile: "Prod_Name", "digitalocean-name": "Bad_One" }))
      .some((e) => e.startsWith(":digitalocean-name must be"))).toBe(true);
    // A missing profile is the required-key error alone, not a name error too.
    expect(validate.stateErrors(doFixture({ profile: null })).some((e) => e.includes("hostname-like"))).toBe(false);
  });

  test("compute keys are provider-scoped", () => {
    expect(validate.computeKey(fixture(), "ssh-sources")).toBe("vultr-ssh-sources");
    expect(validate.computeKey(doFixture(), "http-sources")).toBe("digitalocean-http-sources");
  });

  // --- the network contract

  test("cidr syntax", () => {
    for (const ok of ["0.0.0.0/0", "10.0.0.0/8", "203.0.113.7/32", "::/0", "2001:db8::/32",
                      "fe80::1/128", "2001:db8:0:0:0:0:0:1/64",
                      // IPv4-embedded tails occupy the last two groups.
                      "::ffff:192.0.2.1/128", "64:ff9b::192.0.2.33/96", "1:2:3:4:5:6:192.0.2.1/128"]) {
      expect(validate.cidr(ok)).toBe(true);
    }
    for (const bad of ["10.0.0.0", "10.0.0.256/8", "10.0.0.0/33", "2001:db8::/129", "example.com/24",
                       "1:::2/64", "2001:db8::1::2/64", "1:2:3:4:5:6:7:8:9/64", "", "/24", "10.0.0.0/8/8",
                       // A malformed or misplaced dotted-quad tail.
                       "::ffff:192.0.2.256/128", "::ffff:192.0.2/128", "1:2:3:4:5:6:7:192.0.2.1/128",
                       "192.0.2.1::/64", "::ffff:192.0.2.1:1/128"]) {
      expect(validate.cidr(bad)).toBe(false);
    }
  });

  test("ssh sources must not be empty; no public HTTP is fine", () => {
    expect(validate.stateErrors(fixture({ "vultr-ssh-sources": [] })))
      .toContain(":vultr-ssh-sources must list at least one CIDR");
    expect(validate.stateErrors(doFixture({ "digitalocean-ssh-sources": " , " })))
      .toContain(":digitalocean-ssh-sources must list at least one CIDR");
    expect(validate.stateErrors(fixture({ "vultr-http-sources": [] }))).toEqual([]);
    expect(validate.stateErrors(doFixture({ "digitalocean-http-sources": [] }))).toEqual([]);
  });

  test("malformed sources are refused before any provider call", () => {
    expect(validate.stateErrors(fixture({ "vultr-http-sources": ["0.0.0.0/0", "10.0.0.0"] })))
      .toContain(':vultr-http-sources entry "10.0.0.0" is not an IPv4 or IPv6 CIDR');
    expect(validate.stateErrors(doFixture({ "digitalocean-ssh-sources": "office.example.com/32" })))
      .toContain(':digitalocean-ssh-sources entry "office.example.com/32" is not an IPv4 or IPv6 CIDR');
    // Only the selected provider's lists are checked.
    expect(validate.stateErrors(doFixture({ "vultr-ssh-sources": ["garbage"] }))).toEqual([]);
  });

  // --- provider switching is a rebuild

  test("provider state is compared with the selection", () => {
    expect(validate.providerStateErrors(fixture(), undefined)).toEqual([]);
    expect(validate.providerStateErrors(fixture(), { provider: "vultr", ip: "203.0.113.9" })).toEqual([]);
    expect(validate.providerStateErrors(doFixture(), { provider: "digitalocean" })).toEqual([]);
    expect(validate.providerStateErrors(fixture(), { provider: "digitalocean", ip: "203.0.113.9" }))
      .toEqual(["state holds a digitalocean machine; set provider-compute back to digitalocean and delete first"]);
    expect(validate.providerStateErrors(doFixture(), { provider: "vultr" }))
      .toEqual(["state holds a vultr machine; set provider-compute back to vultr and delete first"]);
  });

  test("legacy state without a provider is the default provider's", () => {
    expect(validate.providerStateErrors(fixture(), { ip: "203.0.113.9" })).toEqual([]);
    const [error] = validate.providerStateErrors(doFixture(), { ip: "203.0.113.9" });
    expect(error).toContain("no recorded provider");
    expect(error).toContain("set provider-compute back to vultr and delete first");
  });

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
    for (const part of ["host", "image", "root-email", "provider-dns", "provider-compute",
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
    for (const name of ["COLORS_PAR_VULTR_API_KEY", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
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

  test("secrets and tofu env follow the selected provider", () => {
    const create = validate.secretErrors(doFixture(), "create").join("\n");
    expect(create).toContain("COLORS_PAR_DO_TOKEN");
    expect(create).toContain("COLORS_PAR_CLOUDFLARE_API_TOKEN");
    expect(create).toContain("COLORS_PAR_SIGNOZ_ROOT_PASSWORD");
    expect(create).not.toContain("COLORS_PAR_VULTR_API_KEY");
    const del = validate.secretErrors(doFixture(), "delete").join("\n");
    expect(del).toContain("COLORS_PAR_DO_TOKEN");
    expect(del).not.toContain("COLORS_PAR_SIGNOZ_ROOT_PASSWORD");
    expect(validate.tofuEnv(doFixture(), "provider-compute")).toEqual({ "do-token": "DIGITALOCEAN_TOKEN" });
    expect(validate.tofuEnv(fixture(), "provider-compute")).toEqual({ "vultr-api-key": "VULTR_API_KEY" });
    expect(validate.tofuEnv(fixture({ "provider-compute": "hetzner" }), "provider-compute")).toEqual({});
  });

  test("a delete asks only for the providers", () => {
    // Destroying a machine must not require the credentials needed to converge
    // one; a missing root password should not be a lock on the exit.
    const errors = validate.secretErrors(fixture(), "delete").join("\n");
    expect(errors).toContain("COLORS_PAR_VULTR_API_KEY");
    expect(errors).not.toContain("COLORS_PAR_SIGNOZ_ROOT_PASSWORD");
    expect(errors).not.toContain("BACKUP");
  });
});

// --- tools -------------------------------------------------------------------

describe("tools", () => {
  test("firewall sources parse and infrastructure data carries the ssh mode", () => {
    const data = tools.infrastructureData(fixture());
    expect(tools.cidrs(data, "vultr-http-sources")).toEqual(["0.0.0.0/0", "::/0"]);
    expect(data["ssh-keygen"]).toBe(true);
    expect(tools.infrastructureData(optout())["ssh-keygen"]).toBe(false);
    expect(tools.infrastructureData(doFixture())["ssh-keygen"]).toBe(true);
    expect(tools.infrastructureData(doOptout())["ssh-keygen"]).toBe(false);
  });

  test("infrastructure data reads the selected provider's keys", () => {
    // The template interpolates one resolved name and one resolved list per
    // port, whichever provider they came from.
    const data = tools.infrastructureData(doFixture({ "digitalocean-ssh-sources": ["10.0.0.0/8"],
      "vultr-ssh-sources": ["192.0.2.0/24"] }));
    expect(data["ssh-sources-hcl"]).toBe('["10.0.0.0/8"]');
    expect(data["compute-name"]).toBe("signoz-digitalocean-fixture");
    expect(tools.infrastructureData(fixture())["compute-name"]).toBe("signoz-fixture");
  });

  test("the template directory follows the provider", () => {
    expect(tools.infrastructureTemplate(fixture()).name).toBe("infrastructure/vultr/main.tf");
    expect(tools.infrastructureTemplate(doFixture()).name).toBe("infrastructure/digitalocean/main.tf");
    expect(tools.infrastructureTemplate(doFixture()).content).toContain('provider = "digitalocean"');
    expect(tools.infrastructureTemplate(fixture()).content).toContain('provider = "vultr"');
    // A registry entry without a template would pass every unit test and
    // fail the first build.
    expect(() => tools.infrastructureTemplate(fixture({ "provider-compute": "hetzner" }))).toThrow();
  });

  test("fallback params are shaped per provider", () => {
    expect(tools.fallbackParams(fixture())).toEqual({ provider: "vultr", ip: "192.0.2.10",
      user: "root", sudoer: "root", name: "signoz-fixture" });
    expect(tools.fallbackParams(doFixture())).toEqual({ provider: "digitalocean", ip: "192.0.2.10",
      user: "root", sudoer: "root", name: "signoz-digitalocean-fixture" });
  });

  test("a real create refuses a missing ip output", () => {
    // 192.0.2.10 is the documentation address build renders with; a real
    // converge must never fall back to it.
    const refused = tools.resolvedCompute({}, tools.fallbackParams(fixture()), undefined);
    expect(refused["red/exit"]).toBe(1);
    expect(String(refused["red/err"])).toContain("compute produced no ip output");
    expect(tools.resolvedCompute({}, tools.fallbackParams(fixture()), { name: "x" })["red/exit"]).toBe(1);
    const ok = tools.resolvedCompute({}, tools.fallbackParams(fixture()),
      { ip: "203.0.113.9", provider: "vultr" });
    expect(ok["red/exit"]).toBeUndefined();
    expect(ok.ip).toBe("203.0.113.9");
  });

  test("cidrs accept overlay strings", () => {
    expect(tools.cidrs({ x: "10.0.0.0/8, 20.0.0.0/8" }, "x"))
      .toEqual(["10.0.0.0/8", "20.0.0.0/8"]);
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

  test("a delete without compute skips the host entirely", async () => {
    // There is no machine to stop, and the cleanup play would only fail
    // against the placeholder address.
    const result = await tools.ansibleStep(fixture({ "red/event": "delete" }));
    expect(result["red/exit"]).toBe(0);
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

describe("ssh", () => {
  test("build renders a stable placeholder path", () => {
    const opts = ssh.withMachineKey(fixture({ "red/event": "build" }));
    expect(String(opts["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
    expect(opts["vultr-ssh-keys"]).toBe(opts["ssh-public-key-path"]);
    expect(String(opts["ssh-private-key-path"])).not.toContain(home);
  });

  test("the build placeholder lands on the selected provider's key", () => {
    // ONCE's table decides which desired-state key carries the machine key,
    // so a second provider needs no second branch here.
    const opts = ssh.withMachineKey(doFixture({ "red/event": "build" }));
    expect(opts["digitalocean-ssh-keys"]).toBe(opts["ssh-public-key-path"]);
    expect("vultr-ssh-keys" in opts).toBe(false);
    expect(String(opts["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
    const optedOut = ssh.withMachineKey(doOptout({ "red/event": "build" }));
    expect(optedOut["digitalocean-ssh-keys"]).toBe("00000000");
    expect(optedOut["ssh-public-key-path"]).toBeUndefined();
  });

  test("a dry-run renders the placeholder too", () => {
    const opts = ssh.withMachineKey(fixture({ "red/event": "create", "red/dry-run": true }));
    expect(String(opts["ssh-public-key-path"])).toStartWith(ssh.buildPlaceholderDir);
  });

  test("real events render the real path", () => {
    const opts = ssh.withMachineKey(fixture({ "red/event": "create" }));
    expect(opts["ssh-private-key-path"]).toBe(join(home, ".ssh", "signoz-fixture"));
    expect(opts["ssh-public-key-path"]).toBe(join(home, ".ssh", "signoz-fixture.pub"));
  });

  test("opt-out passes through untouched", () => {
    for (const event of ["build", "create", "delete"]) {
      const opts = ssh.withMachineKey(optout({ "red/event": event }));
      expect(opts["vultr-ssh-keys"]).toBe("00000000-0000-0000-0000-000000000000");
      expect(opts["ssh-public-key-path"]).toBeUndefined();
      expect(opts["ssh-keygen"]).toBeUndefined();
    }
  });

  test("first create generates the keypair", async () => {
    const opts = await ssh.ensureKey(fixture({ "red/event": "create" }), async () => undefined);
    const prv = join(home, ".ssh", "signoz-fixture");
    const pub = `${prv}.pub`;
    expect(opts["red/err"]).toBeUndefined();
    expect(existsSync(prv)).toBe(true);
    expect(existsSync(pub)).toBe(true);
    // ed25519, no passphrase, profile-named comment
    expect(readFileSync(pub, "utf8")).toContain("ssh-ed25519");
    expect(readFileSync(pub, "utf8")).toContain("signoz-fixture managed by Colors");
    // 600 on the private key, 700 on ~/.ssh
    expect(statSync(prv).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".ssh")).mode & 0o777).toBe(0o700);
  });

  test("converge reuses an existing key", async () => {
    write(join(home, ".ssh", "signoz-fixture"), "private");
    write(join(home, ".ssh", "signoz-fixture.pub"), "ssh-ed25519 AAAA test");
    const opts = await ssh.ensureKey(fixture({ "red/event": "create" }),
      async () => ({ ip: "192.0.2.10" }));
    expect(opts["red/err"]).toBeUndefined();
    expect(readFileSync(join(home, ".ssh", "signoz-fixture"), "utf8")).toBe("private");
  });

  test("state without a key is an error", async () => {
    const opts = await ssh.ensureKey(fixture({ "red/event": "create" }),
      async () => ({ ip: "192.0.2.10" }));
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("does not hold the machine key");
    expect(String(opts["red/err"])).toContain("rebuild");
  });

  test("a key without state is never overwritten", async () => {
    const prv = join(home, ".ssh", "signoz-fixture");
    write(prv, "irreplaceable");
    write(`${prv}.pub`, "ssh-ed25519 AAAA test");
    const opts = await ssh.ensureKey(fixture({ "red/event": "create" }), async () => undefined);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("no compute state is readable");
    expect(String(opts["red/err"])).toContain("survives");
    expect(readFileSync(prv, "utf8")).toBe("irreplaceable");
  });

  test("half a keypair is an error", async () => {
    write(join(home, ".ssh", "signoz-fixture"), "private");
    const opts = await ssh.ensureKey(fixture({ "red/event": "create" }), async () => undefined);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("half a keypair");
  });

  test("opt-out generates nothing", async () => {
    const opts = await ssh.ensureKey(optout({ "red/event": "create" }), async () => undefined);
    expect(opts["red/err"]).toBeUndefined();
    expect(existsSync(join(home, ".ssh"))).toBe(false);
  });

  test("preflight passes when no account key matches, or when it is ours", async () => {
    const clean = await ssh.preflight(ssh.withMachineKey(fixture({ "red/event": "create" })),
      async () => [{ id: "1", name: "someone-else", public: "ssh-ed25519 BBBB" }]);
    expect(clean["red/err"]).toBeUndefined();
    const owned = await ssh.preflight(
      ssh.withMachineKey(fixture({ "red/event": "create",
        "once/ssh-state-params": { ssh_key_id: "abc" } })),
      async () => [{ id: "abc", name: "signoz-fixture", public: "ssh-ed25519 AAAA" }]);
    expect(owned["red/err"]).toBeUndefined();
  });

  test("preflight refuses our leftover key", async () => {
    write(join(home, ".ssh", "signoz-fixture.pub"), "ssh-ed25519 AAAA comment");
    const opts = await ssh.preflight(ssh.withMachineKey(fixture({ "red/event": "create" })),
      async () => [{ id: "abc", name: "signoz-fixture", public: "ssh-ed25519 AAAA" }]);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("previous delete");
    expect(String(opts["red/err"])).toContain("delete that key");
  });

  test("preflight refuses a foreign key and says do not delete it", async () => {
    write(join(home, ".ssh", "signoz-fixture.pub"), "ssh-ed25519 OURS comment");
    const opts = await ssh.preflight(ssh.withMachineKey(fixture({ "red/event": "create" })),
      async () => [{ id: "abc", name: "signoz-fixture", public: "ssh-ed25519 THEIRS" }]);
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("Do not delete it");
  });

  test("preflight lists keys with the selected provider's token", async () => {
    // ONCE selects the REST API and the token by provider; this proves the
    // delegation hands each provider its own credential.
    const seen: Array<[string, string]> = [];
    const capture = async (provider: string, token: string) => { seen.push([provider, token]); return []; };
    await ssh.preflight(ssh.withMachineKey(doFixture({ "red/event": "create",
      "do-token": "do-secret", "vultr-api-key": "wrong" })), capture);
    await ssh.preflight(ssh.withMachineKey(fixture({ "red/event": "create",
      "vultr-api-key": "vultr-secret", "do-token": "wrong" })), capture);
    expect(seen).toEqual([["digitalocean", "do-secret"], ["vultr", "vultr-secret"]]);
  });

  test("preflight failure is an error, not a skip", async () => {
    const opts = await ssh.preflight(ssh.withMachineKey(fixture({ "red/event": "create" })),
      async () => { throw new Error("HTTP 500"); });
    expect(opts["red/exit"]).toBe(1);
    expect(String(opts["red/err"])).toContain("cannot list");
  });

  test("delete removes the keypair; ~/.ssh itself survives", () => {
    write(join(home, ".ssh", "signoz-fixture"), "private");
    write(join(home, ".ssh", "signoz-fixture.pub"), "public");
    ssh.cleanupStep(fixture({ "red/event": "delete", "ssh-keygen": true }));
    expect(existsSync(join(home, ".ssh", "signoz-fixture"))).toBe(false);
    expect(existsSync(join(home, ".ssh", "signoz-fixture.pub"))).toBe(false);
    expect(existsSync(join(home, ".ssh"))).toBe(true);
  });

  test("cleanup is inert on create and in opt-out mode", () => {
    write(join(home, ".ssh", "signoz-fixture"), "private");
    ssh.cleanupStep(fixture({ "red/event": "create", "ssh-keygen": true }));
    expect(existsSync(join(home, ".ssh", "signoz-fixture"))).toBe(true);
    ssh.cleanupStep(optout({ "red/event": "delete" }));
    expect(existsSync(join(home, ".ssh", "signoz-fixture"))).toBe(true);
  });
});

// --- ~/.ssh/config (SSH Config Standard) -------------------------------------

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

describe("workflow", () => {
  // The compute state is read once per run, through the injectable reader,
  // on a real create or delete. Every lifecycle test stubs it: undefined is a
  // readable state holding no compute, a map is a recorded `params`, and a
  // throw is a backend that cannot be read.
  const start = (opts: Opts, state: Record<string, unknown> | undefined) =>
    workflow.startStep(opts, {}, async () => state);
  const startUnreadable = (opts: Opts) =>
    workflow.startStep(opts, {}, async () => { throw new Error("tofu output failed: no backend"); });
  const credentials = { "vultr-api-key": "v", "do-token": "d", "cloudflare-api-token": "c",
    "r2-access-key-id": "a", "r2-secret-access-key": "s",
    "signoz-root-password": "p", "signoz-backup-r2-access-key-id": "bk",
    "signoz-backup-r2-secret-access-key": "bs" };

  test("build and dry-run need no credentials and never touch ~/.ssh or the state", async () => {
    // The standard forbids reading, creating, or requiring anything under
    // ~/.ssh on a build or dry-run: they render from desired state alone.
    // A poisoned config proves nothing in the build path reads it, and a
    // throwing reader proves nothing on these paths reads the backend.
    write(join(home, ".ssh", "config"), "ServerAliveInterval 60\nHost signoz-fixture\n");
    for (const opts of [fixture({ "red/event": "build" }),
                        fixture({ "red/event": "create", "red/dry-run": true }),
                        doFixture({ "red/event": "delete", "red/dry-run": true })]) {
      const result = await startUnreadable(opts);
      expect(result["red/exit"]).toBe(0);
      expect(String(result["ssh-public-key-path"])).toStartWith("/home/build-placeholder");
    }
  });

  test("a real create requires credentials", async () => {
    const result = await start(fixture({ "red/event": "create" }), undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
    expect(String(result["red/err"])).toContain("COLORS_PAR_CLOUDFLARE_API_TOKEN");
    expect(String(result["red/err"])).toContain("COLORS_PAR_SIGNOZ_ROOT_PASSWORD");
  });

  test("a real create and delete require the selected provider's credentials", async () => {
    const create = await start(doFixture({ "red/event": "create" }), undefined);
    expect(create["red/exit"]).toBe(2);
    expect(String(create["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
    expect(String(create["red/err"])).toContain("COLORS_PAR_SIGNOZ_ROOT_PASSWORD");
    expect(String(create["red/err"])).not.toContain("COLORS_PAR_VULTR_API_KEY");
    const del = await start(doFixture({ "red/event": "delete", "compute-prevent-destroy": false }), undefined);
    expect(del["red/exit"]).toBe(2);
    expect(String(del["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
    expect(String(del["red/err"])).not.toContain("COLORS_PAR_SIGNOZ_ROOT_PASSWORD");
    expect(String(del["red/err"])).not.toContain("COLORS_PAR_VULTR_API_KEY");
    const vultr = await start(fixture({ "red/event": "delete", "compute-prevent-destroy": false }), undefined);
    expect(String(vultr["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
    expect(String(vultr["red/err"])).not.toContain("COLORS_PAR_DO_TOKEN");
  });

  test("delete is protected", async () => {
    const result = await start(fixture({ "red/event": "delete" }), undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
  });

  // --- provider switching is a rebuild, never an apply

  test("a provider switch is refused on create and delete", async () => {
    for (const event of ["create", "delete"]) {
      const vultr = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
        { provider: "digitalocean", ip: "203.0.113.9" });
      expect(vultr["red/exit"]).toBe(2);
      expect(String(vultr["red/err"]))
        .toContain("state holds a digitalocean machine; set provider-compute back to digitalocean and delete first");
      // The validator order is the thing under test: the actionable error,
      // not a missing token for the provider that was just selected.
      expect(String(vultr["red/err"])).not.toContain("required credential is not set");
      const digitalocean = await start(doFixture({ "red/event": event, "compute-prevent-destroy": false }),
        { provider: "vultr", ip: "203.0.113.9" });
      expect(digitalocean["red/exit"]).toBe(2);
      expect(String(digitalocean["red/err"])).toContain("state holds a vultr machine; set provider-compute back to vultr");
      expect(String(digitalocean["red/err"])).not.toContain("COLORS_PAR_DO_TOKEN");
    }
  });

  test("legacy state accepts only the default provider", async () => {
    for (const event of ["create", "delete"]) {
      const vultr = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
        { ip: "203.0.113.9" });
      expect(String(vultr["red/err"])).not.toContain("state holds");
      expect(String(vultr["red/err"])).toContain("required credential is not set");
      const digitalocean = await start(doFixture({ "red/event": event, "compute-prevent-destroy": false }),
        { ip: "203.0.113.9" });
      expect(digitalocean["red/exit"]).toBe(2);
      expect(String(digitalocean["red/err"])).toContain("no recorded provider");
      expect(String(digitalocean["red/err"])).toContain("set provider-compute back to vultr and delete first");
      expect(String(digitalocean["red/err"])).not.toContain("COLORS_PAR_DO_TOKEN");
    }
  });

  test("a matching provider passes to the credentials", async () => {
    const result = await start(fixture({ "red/event": "create" }), { provider: "vultr", ip: "203.0.113.9" });
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).not.toContain("state holds");
    expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
  });

  test("an unreadable backend counts as no state on create", async () => {
    // A fresh clone has no readable state and must still be able to create.
    const result = await startUnreadable(fixture({ "red/event": "create" }));
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).not.toContain("could not read");
    expect(String(result["red/err"])).not.toContain("state holds");
    expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
  });

  test("an unreadable backend fails a real delete closed", async () => {
    // Swallowing it is how a teardown ends up converging against 192.0.2.10.
    const result = await startUnreadable(fixture({ ...credentials, "red/event": "delete",
      "compute-prevent-destroy": false }));
    expect(result["red/exit"]).toBe(1);
    expect(String(result["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
    expect(String(result["red/err"])).toContain("no backend");
  });

  test("a real delete adopts the recorded address", async () => {
    const adopted = await start(fixture({ ...credentials, "red/event": "delete", "compute-prevent-destroy": false }),
      { provider: "vultr", ip: "203.0.113.9", user: "root" });
    expect(adopted["red/exit"]).toBe(0);
    expect(adopted.ip).toBe("203.0.113.9");
    // A readable state without compute leaves the address unset, and the
    // cleanup step skips itself.
    const empty = await start(fixture({ ...credentials, "red/event": "delete", "compute-prevent-destroy": false }),
      undefined);
    expect(empty["red/exit"]).toBe(0);
    expect(empty.ip).toBeUndefined();
  });

  test("the create graph orders the stack", () => {
    const next = (step: string) =>
      (workflow.wireFn(step, { "red/event": "create" }) ?? []).slice(1);
    expect(next("signoz/start")).toEqual(["signoz/infrastructure"]);
    expect(next("signoz/infrastructure")).toEqual(["signoz/ssh-config"]);
    expect(next("signoz/ssh-config")).toEqual(["signoz/dns"]);
    // DNS before convergence: Caddy asks Let's Encrypt for a certificate as
    // soon as it starts, and that only resolves once the record exists.
    expect(next("signoz/dns")).toEqual(["signoz/ansible"]);
    expect(next("signoz/ansible")).toEqual(["signoz/acceptance"]);
  });

  test("delete removes the config block before the destroy and the key after it", () => {
    const next = (step: string) =>
      (workflow.wireFn(step, { "red/event": "delete" }) ?? []).slice(1);
    expect(next("signoz/start")).toEqual(["signoz/ansible"]);
    expect(next("signoz/ansible")).toEqual(["signoz/dns"]);
    expect(next("signoz/dns")).toEqual(["signoz/ssh-config"]);
    expect(next("signoz/ssh-config")).toEqual(["signoz/infrastructure"]);
    expect(next("signoz/infrastructure")).toEqual(["signoz/ssh-cleanup"]);
    expect(next("signoz/ssh-cleanup")).toEqual([]);
  });
});
