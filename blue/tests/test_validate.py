from conftest import do_fixture, do_optout, fixture, optout
from package_signoz_blue import validate


def test_fixture_is_valid():
    assert validate.state_errors(fixture()) == []


def test_optout_fixture_is_valid():
    assert validate.state_errors(optout()) == []


def test_digitalocean_fixtures_are_valid():
    assert validate.state_errors(do_fixture()) == []
    assert validate.state_errors(do_optout()) == []


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


def test_vultr_os_id_is_checked_on_vultr_only():
    assert ":vultr-os-id must be Vultr's numeric operating-system id" in \
        validate.state_errors(fixture({"vultr-os-id": "2284"}))
    assert validate.state_errors(do_fixture({"vultr-os-id": "2284"})) == []


def test_digitalocean_refuses_a_pinned_or_created_vpc():
    errors = validate.state_errors(do_fixture({"digitalocean-vpc-uuid": "abc",
                                               "digitalocean-vpc-cidr": "10.0.0.0/16"}))
    assert any(e.startswith(":digitalocean-vpc-uuid must be absent") for e in errors)
    assert any(e.startswith(":digitalocean-vpc-cidr must be absent") for e in errors)
    # An unselected provider's keys are ignored, VPC keys included.
    assert validate.state_errors(fixture({"digitalocean-vpc-uuid": "abc"})) == []


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


def test_the_name_override_is_validated_against_the_providers_rules():
    assert ":vultr-name must be a safe 1-63 character name" in \
        validate.state_errors(fixture({"vultr-name": "no spaces!"}))
    assert ":vultr-name must be a safe 1-63 character name" in \
        validate.state_errors(fixture({"vultr-name": "a" * 64}))
    # Vultr labels are console text; DigitalOcean droplet names are hostnames,
    # so an underscore that Vultr accepts fails at DigitalOcean.
    assert validate.state_errors(fixture({"vultr-name": "invalid_name"})) == []
    err = (":digitalocean-name must be a hostname-like name: lowercase letters, "
           "digits, dots and hyphens, 1-63 characters")
    for bad in ["invalid_name", "Upper", "-leading", "a" * 64]:
        assert err in validate.state_errors(do_fixture({"digitalocean-name": bad})), bad
    assert validate.state_errors(do_fixture({"digitalocean-name": "sig.noz-01"})) == []


def test_the_resolved_name_is_validated_when_it_falls_back_to_the_profile():
    # The profile reaches the provider as the machine name whenever no override
    # is set, so it is held to the same rule and the error names the profile.
    errors = validate.state_errors(do_fixture({"profile": "Prod_Name"}))
    assert (":profile (the digitalocean machine name) must be a hostname-like name: "
            "lowercase letters, digits, dots and hyphens, 1-63 characters") in errors
    assert not any(":digitalocean-name" in e for e in errors)
    # Vultr's rule allows the same profile.
    assert validate.state_errors(fixture({"profile": "Prod_Name", "vultr-name": None})) == []
    # A valid override shadows an invalid profile; an invalid override is the
    # override's error, not the profile's.
    assert validate.state_errors(do_fixture({"profile": "Prod_Name", "digitalocean-name": "prod"})) == []
    assert any(e.startswith(":digitalocean-name must be") for e in
               validate.state_errors(do_fixture({"profile": "Prod_Name", "digitalocean-name": "Bad_One"})))
    # A missing profile is the required-key error alone, not a name error too.
    assert not any("hostname-like" in e for e in validate.state_errors(do_fixture({"profile": None})))


def test_compute_key_is_provider_scoped():
    assert validate.compute_key(fixture(), "ssh-sources") == "vultr-ssh-sources"
    assert validate.compute_key(do_fixture(), "http-sources") == "digitalocean-http-sources"


# --- the network contract


def test_cidr_syntax():
    for ok in ["0.0.0.0/0", "10.0.0.0/8", "203.0.113.7/32", "::/0", "2001:db8::/32",
               "fe80::1/128", "2001:db8:0:0:0:0:0:1/64",
               # IPv4-embedded tails occupy the last two groups.
               "::ffff:192.0.2.1/128", "64:ff9b::192.0.2.33/96", "1:2:3:4:5:6:192.0.2.1/128"]:
        assert validate.cidr(ok), ok
    for bad in ["10.0.0.0", "10.0.0.256/8", "10.0.0.0/33", "2001:db8::/129", "example.com/24",
                "1:::2/64", "2001:db8::1::2/64", "1:2:3:4:5:6:7:8:9/64", "", "/24", "10.0.0.0/8/8",
                # A malformed or misplaced dotted-quad tail.
                "::ffff:192.0.2.256/128", "::ffff:192.0.2/128", "1:2:3:4:5:6:7:192.0.2.1/128",
                "192.0.2.1::/64", "::ffff:192.0.2.1:1/128"]:
        assert not validate.cidr(bad), bad


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


# --- provider switching is a rebuild


def test_provider_state_is_compared_with_the_selection():
    assert validate.provider_state_errors(fixture(), None) == []
    assert validate.provider_state_errors(fixture(), {"provider": "vultr", "ip": "203.0.113.9"}) == []
    assert validate.provider_state_errors(do_fixture(), {"provider": "digitalocean"}) == []
    assert validate.provider_state_errors(fixture(), {"provider": "digitalocean", "ip": "203.0.113.9"}) == \
        ["state holds a digitalocean machine; set provider-compute back to digitalocean and delete first"]
    assert validate.provider_state_errors(do_fixture(), {"provider": "vultr"}) == \
        ["state holds a vultr machine; set provider-compute back to vultr and delete first"]


def test_legacy_state_without_a_provider_is_the_default_providers():
    # Every deployment created before adoption recorded no provider and runs
    # the only provider the package ever offered.
    assert validate.provider_state_errors(fixture(), {"ip": "203.0.113.9"}) == []
    [error] = validate.provider_state_errors(do_fixture(), {"ip": "203.0.113.9"})
    assert "no recorded provider" in error
    assert "set provider-compute back to vultr and delete first" in error


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
