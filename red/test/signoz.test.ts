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

function readFixture(path: string, overrides: Opts): Opts {
  const text = readFileSync(path, "utf8").replaceAll("WORKDIR", ".colors");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}

const fixture = (overrides: Opts = {}) => readFixture(fixtureFile, overrides);
const optout = (overrides: Opts = {}) => readFixture(optoutFile, overrides);

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
  test("both fixtures are valid", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
    expect(validate.stateErrors(optout())).toEqual([]);
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
      "provider-dns": "other", "provider-compute": "digitalocean",
      "signoz-backup-retention-days": 0,
      "signoz-backup-dir": "relative/path",
      "vultr-os-id": "2284",
    }));
    expect(errors.length).toBeGreaterThanOrEqual(8);
    for (const part of ["host", "image", "root-email", "provider-dns", "vultr", "os-id",
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
  test("build and dry-run need no credentials and never touch ~/.ssh", async () => {
    // The standard forbids reading, creating, or requiring anything under
    // ~/.ssh on a build or dry-run: they render from desired state alone.
    // A poisoned config proves nothing in the build path reads it.
    write(join(home, ".ssh", "config"), "ServerAliveInterval 60\nHost signoz-fixture\n");
    for (const overrides of [{ "red/event": "build" },
                             { "red/event": "create", "red/dry-run": true }]) {
      const result = await workflow.startStep(fixture(overrides), {});
      expect(result["red/exit"]).toBe(0);
      expect(String(result["ssh-public-key-path"])).toStartWith("/home/build-placeholder");
    }
  });

  test("a real create requires credentials", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "create" }), {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_VULTR_API_KEY");
    expect(String(result["red/err"])).toContain("COLORS_PAR_CLOUDFLARE_API_TOKEN");
    expect(String(result["red/err"])).toContain("COLORS_PAR_SIGNOZ_ROOT_PASSWORD");
  });

  test("delete is protected", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "delete" }), {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
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
