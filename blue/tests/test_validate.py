from conftest import do_fixture, do_optout, fixture, optout
from package_signoz_blue import validate


def test_fixture_is_valid():
    assert validate.state_errors(fixture()) == []


def test_optout_fixture_is_valid():
    assert validate.state_errors(optout()) == []


def test_digitalocean_fixtures_are_valid():
    assert validate.state_errors(do_fixture()) == []
    assert validate.state_errors(do_optout()) == []


# --- the spec handed to ONCE


def test_the_spec_carries_this_packages_registry_sources_and_default():
    # The operations are ONCE's; this is the data they run over. A colour
    # whose registry, sources or default drifts fails here, in that colour.
    assert sorted(validate.spec["registry"]) == ["digitalocean", "vultr"]
    assert validate.spec["registry"] is validate.compute_providers
    assert validate.spec["registry"]["digitalocean"] == {
        "required": ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                     "digitalocean-ssh-sources", "digitalocean-http-sources"],
        "secrets": ["do-token"],
        "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
    }
    assert validate.spec["registry"]["vultr"] == {
        "required": ["vultr-region", "vultr-plan", "vultr-os-id",
                     "vultr-ssh-sources", "vultr-http-sources"],
        "secrets": ["vultr-api-key"],
        "tofu-env": {"vultr-api-key": "VULTR_API_KEY"},
    }
    assert validate.spec["sources"] == {"non_empty": ["ssh-sources"], "may_be_empty": ["http-sources"]}
    assert validate.spec["default"] == "vultr"
    assert validate.spec["default"] == validate.default_compute_provider
    # The name rules are ONCE's.
    assert "name_rules" not in validate.spec


# --- the compute-provider registry


def test_unsupported_provider_names_the_advertised_ones():
    assert ":provider-compute must be one of digitalocean, vultr" in \
        validate.state_errors(fixture({"provider-compute": "hetzner"}))


def test_required_keys_follow_the_selected_provider():
    assert ":digitalocean-size is required" in validate.state_errors(do_fixture({"digitalocean-size": None}))
    assert ":vultr-plan is required" in validate.state_errors(fixture({"vultr-plan": None}))
    # The other provider's keys are neither required nor refused, so one
    # colors.yml can carry both and move between providers by one edit.
    assert not any("vultr" in e for e in validate.state_errors(do_fixture()))
    assert validate.state_errors(fixture({"digitalocean-region": "ams3",
                                          "digitalocean-size": "s-1vcpu-1gb"})) == []
    assert validate.state_errors(do_fixture({"vultr-os-id": "not-checked-here"})) == []


def test_name_and_machine_key_are_never_required():
    # Compute Name Standard: the profile is the default. SSH Keypair Standard:
    # absence selects keygen mode.
    for errors in [validate.state_errors(fixture({"vultr-name": None})),
                   validate.state_errors(do_fixture())]:
        assert not any("-name" in e for e in errors)
        assert not any("-ssh-keys" in e for e in errors)


# --- the compute name


def test_compute_name_falls_back_to_the_profile():
    assert validate.compute_name(do_fixture()) == "signoz-digitalocean-fixture"
    assert validate.compute_name(do_optout()) == "signoz-digitalocean-optout"
    assert validate.compute_name(fixture({"vultr-name": None})) == "signoz-fixture"
    assert validate.compute_name(fixture({"vultr-name": ""})) == "signoz-fixture"
    assert validate.compute_name(fixture({"vultr-name": "REPLACE_ME"})) == "signoz-fixture"
    assert validate.compute_name(fixture({"vultr-name": "custom-label"})) == "custom-label"
    # The override is read from the selected provider's key alone.
    assert validate.compute_name(do_fixture({"vultr-name": "custom-label"})) == \
        "signoz-digitalocean-fixture"


def test_compute_key_is_provider_scoped():
    assert validate.compute_key(fixture(), "ssh-sources") == "vultr-ssh-sources"
    assert validate.compute_key(do_fixture(), "http-sources") == "digitalocean-http-sources"


# --- the network contract


def test_ssh_sources_must_not_be_empty():
    assert ":vultr-ssh-sources must list at least one CIDR" in \
        validate.state_errors(fixture({"vultr-ssh-sources": []}))
    assert ":digitalocean-ssh-sources must list at least one CIDR" in \
        validate.state_errors(do_fixture({"digitalocean-ssh-sources": " , "}))
    # No public HTTP is a legitimate deployment.
    assert validate.state_errors(fixture({"vultr-http-sources": []})) == []
    assert validate.state_errors(do_fixture({"digitalocean-http-sources": []})) == []


def test_malformed_sources_are_refused_before_any_provider_call():
    assert ':vultr-http-sources entry "10.0.0.0" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(fixture({"vultr-http-sources": ["0.0.0.0/0", "10.0.0.0"]}))
    assert ':digitalocean-ssh-sources entry "office.example.com/32" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(do_fixture({"digitalocean-ssh-sources": "office.example.com/32"}))
    # Only the selected provider's lists are checked.
    assert validate.state_errors(do_fixture({"vultr-ssh-sources": ["garbage"]})) == []


def test_machine_key_is_not_required():
    # The standard makes absence meaningful: requiring vultr-ssh-keys would
    # make every conforming deployment invalid.
    assert not any("vultr-ssh-keys" in e for e in validate.state_errors(fixture()))


def test_absent_machine_key_selects_keygen():
    assert validate.keygen(fixture()) is True
    assert validate.keygen(optout()) is False


def test_reports_all_errors():
    errors = validate.state_errors(fixture({
        "signoz-host": "bad", "signoz-image": "floating",
        "signoz-root-email": "not-an-email",
        "provider-dns": "other", "provider-compute": "hetzner",
        "signoz-backup-retention-days": 0,
        "signoz-backup-dir": "relative/path"}))
    assert len(errors) >= 7
    for part in ["host", "image", "root-email", "provider-dns", "provider-compute",
                 "retention-days", "backup-dir"]:
        assert any(part in e for e in errors), part


def test_accepts_a_digest_pin():
    assert validate.state_errors(fixture(
        {"signoz-caddy-image": "caddy@sha256:" + "a" * 64})) == []


def test_the_application_and_collector_may_not_float():
    # They version independently upstream and share a schema, so nothing can
    # check the pair is compatible. What can be checked is that neither moves
    # on its own between converges.
    for k in ["signoz-image", "signoz-collector-image"]:
        errors = validate.state_errors(fixture({k: "signoz/signoz:latest"}))
        assert any("floating tag" in e for e in errors), k


def test_profile_overlay_is_refused():
    assert validate.env_errors({"COLORS_PAR_PROFILE": "other"})
    assert not validate.env_errors({})


def test_a_create_names_every_package_secret():
    errors = "\n".join(validate.secret_errors(fixture(), "create"))
    for name in ["COLORS_PAR_VULTR_API_KEY", "COLORS_PAR_CLOUDFLARE_API_TOKEN",
                 "COLORS_PAR_SIGNOZ_ROOT_PASSWORD",
                 "COLORS_PAR_SIGNOZ_BACKUP_R2_ACCESS_KEY_ID",
                 "COLORS_PAR_SIGNOZ_BACKUP_R2_SECRET_ACCESS_KEY"]:
        assert name in errors, name
    # Both are generated on the server and never supplied by the operator.
    assert "INGEST" not in errors
    assert "POSTGRES" not in errors
    assert "COLORS_PAR_DO_TOKEN" not in errors


def test_secrets_and_tofu_env_follow_the_selected_provider():
    create = "\n".join(validate.secret_errors(do_fixture(), "create"))
    assert "COLORS_PAR_DO_TOKEN" in create
    assert "COLORS_PAR_CLOUDFLARE_API_TOKEN" in create
    assert "COLORS_PAR_SIGNOZ_ROOT_PASSWORD" in create
    assert "COLORS_PAR_VULTR_API_KEY" not in create
    delete = "\n".join(validate.secret_errors(do_fixture(), "delete"))
    assert "COLORS_PAR_DO_TOKEN" in delete
    assert "COLORS_PAR_SIGNOZ_ROOT_PASSWORD" not in delete
    assert validate.tofu_env(do_fixture(), "provider-compute") == {"do-token": "DIGITALOCEAN_TOKEN"}
    assert validate.tofu_env(fixture(), "provider-compute") == {"vultr-api-key": "VULTR_API_KEY"}
    assert validate.tofu_env(fixture({"provider-compute": "hetzner"}), "provider-compute") == {}


def test_a_delete_asks_only_for_the_providers():
    # Destroying a machine must not require the credentials needed to converge
    # one; a missing root password should not be a lock on the exit.
    errors = "\n".join(validate.secret_errors(fixture(), "delete"))
    assert "COLORS_PAR_VULTR_API_KEY" in errors
    assert "COLORS_PAR_SIGNOZ_ROOT_PASSWORD" not in errors
    assert "BACKUP" not in errors
