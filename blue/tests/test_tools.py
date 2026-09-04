import pytest
from conftest import do_fixture, do_optout, fixture, optout
from package_signoz_blue import tools


def spec_for(opts, file):
    return next(s for s in tools.ansible_specs(opts)
                if str(s["target"]).endswith(file))


def test_firewall_sources_parse():
    data = tools.infrastructure_data(fixture())
    assert tools.cidrs(data, "vultr-http-sources") == ["0.0.0.0/0", "::/0"]


def test_infrastructure_data_carries_the_ssh_mode():
    assert tools.infrastructure_data(fixture())["ssh-keygen"] is True
    assert tools.infrastructure_data(optout())["ssh-keygen"] is False
    assert tools.infrastructure_data(do_fixture())["ssh-keygen"] is True
    assert tools.infrastructure_data(do_optout())["ssh-keygen"] is False


def test_infrastructure_data_reads_the_selected_providers_keys():
    # The template interpolates one resolved name and one resolved list per
    # port, whichever provider they came from.
    data = tools.infrastructure_data(do_fixture({"digitalocean-ssh-sources": ["10.0.0.0/8"],
                                                 "vultr-ssh-sources": ["192.0.2.0/24"]}))
    assert data["ssh-sources-hcl"] == '["10.0.0.0/8"]'
    assert data["compute-name"] == "signoz-digitalocean-fixture"
    assert tools.infrastructure_data(fixture())["compute-name"] == "signoz-fixture"


def test_template_directory_follows_the_provider():
    assert tools.infrastructure_template(fixture())["name"] == "tools/infrastructure/vultr/main.tf"
    assert tools.infrastructure_template(do_fixture())["name"] == "tools/infrastructure/digitalocean/main.tf"
    assert 'provider = "digitalocean"' in tools.infrastructure_template(do_fixture())["content"]
    assert 'provider = "vultr"' in tools.infrastructure_template(fixture())["content"]
    # A registry entry without a template would pass every unit test and fail
    # the first build.
    with pytest.raises(FileNotFoundError):
        tools.infrastructure_template(fixture({"provider-compute": "hetzner"}))


def test_fallback_params_are_shaped_per_provider():
    assert tools.fallback_params(fixture()) == {
        "provider": "vultr", "ip": "192.0.2.10", "user": "root", "sudoer": "root",
        "name": "signoz-fixture"}
    assert tools.fallback_params(do_fixture()) == {
        "provider": "digitalocean", "ip": "192.0.2.10", "user": "root", "sudoer": "root",
        "name": "signoz-digitalocean-fixture"}


def test_a_real_create_refuses_a_missing_ip_output():
    # 192.0.2.10 is the documentation address build renders with; a real
    # converge must never fall back to it.
    refused = tools.resolved_compute({}, tools.fallback_params(fixture()), None)
    assert refused["blue/exit"] == 1
    assert "compute produced no ip output" in refused["blue/err"]
    assert tools.resolved_compute({}, tools.fallback_params(fixture()), {"name": "x"})["blue/exit"] == 1
    ok = tools.resolved_compute({}, tools.fallback_params(fixture()),
                                {"ip": "203.0.113.9", "provider": "vultr"})
    assert ok.get("blue/exit") is None
    assert ok["ip"] == "203.0.113.9"


def test_dns_zone_is_registrable_domain():
    assert tools.zone(fixture()) == "example.com"


def test_dns_record_is_host_and_proxied():
    json_text = tools.dns_json({**fixture(), "ip": "192.0.2.10"})
    assert "signoz.example.com" in json_text
    assert "192.0.2.10" in json_text
    assert "proxied" in json_text


def test_inventory_keeps_one_target():
    inventory = tools.inventory({**fixture(), "ip": "192.0.2.10"})
    assert "192.0.2.10" in inventory
    assert "signoz-fixture" in inventory


def test_ansible_renders_the_whole_stack():
    targets = [str(s["target"]) for s in tools.ansible_specs(fixture())]
    for file in ["ansible.cfg", "main.yml", "cleanup.yml", "compose.yml", "Caddyfile",
                 "ingester.yaml", "opamp.yaml", "keeper.yaml", "clickhouse.yaml",
                 "functions.yaml", "smoke.sh", "backup.sh", "backup.service",
                 "backup.timer", "inventory.json"]:
        assert any(t.endswith(file) for t in targets), file


def test_operator_secrets_reach_the_host_as_lookups_not_values():
    # `.colors/` is generated output and the goldens are committed, so the
    # secret must never be the thing that lands on disk — the expression is.
    # The lookups live literally in the template rather than in the data map,
    # because the template engine HTML-escapes a value it interpolates and
    # Ansible would receive `&#39;` instead of a quote.
    template = (tools.ROOT / "tools" / "ansible" / "main.yml").read_text()
    for par in ["COLORS_PAR_SIGNOZ_ROOT_PASSWORD",
                "COLORS_PAR_SIGNOZ_BACKUP_R2_ACCESS_KEY_ID",
                "COLORS_PAR_SIGNOZ_BACKUP_R2_SECRET_ACCESS_KEY"]:
        assert f"lookup('env','{par}')" in template, par


def test_the_data_map_carries_no_operator_secret():
    data = spec_for(fixture(), "main.yml")["data"]
    assert data["signoz-root-email"] == "admin@signoz.example.com"
    for k in ["signoz-root-password", "signoz-backup-access-key",
              "signoz-backup-secret-key"]:
        assert data.get(k) is None, k


async def test_a_delete_without_compute_skips_the_host_entirely():
    # There is no machine to stop, and the cleanup play would only fail
    # against the placeholder address.
    result = await tools.ansible_step({**fixture(), "blue/event": "delete"})
    assert result["blue/exit"] == 0


async def test_acceptance_is_skipped_outside_a_real_create():
    for event in ["build", "delete"]:
        result = await tools.acceptance_step({**fixture(), "blue/event": event})
        assert result["blue/exit"] == 0
