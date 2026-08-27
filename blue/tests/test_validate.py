from conftest import fixture, optout
from package_signoz_blue import validate


def test_fixture_is_valid():
    assert validate.state_errors(fixture()) == []


def test_optout_fixture_is_valid():
    assert validate.state_errors(optout()) == []


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
        "provider-dns": "other", "provider-compute": "digitalocean",
        "signoz-backup-retention-days": 0,
        "signoz-backup-dir": "relative/path",
        "vultr-os-id": "2284"}))
    assert len(errors) >= 8
    for part in ["host", "image", "root-email", "provider-dns", "vultr", "os-id",
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


def test_a_delete_asks_only_for_the_providers():
    # Destroying a machine must not require the credentials needed to converge
    # one; a missing root password should not be a lock on the exit.
    errors = "\n".join(validate.secret_errors(fixture(), "delete"))
    assert "COLORS_PAR_VULTR_API_KEY" in errors
    assert "COLORS_PAR_SIGNOZ_ROOT_PASSWORD" not in errors
    assert "BACKUP" not in errors
