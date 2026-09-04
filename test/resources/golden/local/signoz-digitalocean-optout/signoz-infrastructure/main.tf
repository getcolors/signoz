terraform {
  required_providers {
    digitalocean = { source = "digitalocean/digitalocean", version = "~> 2.0" }
  }
}

provider "digitalocean" {
  # token comes from DIGITALOCEAN_TOKEN in the environment
}

locals {
  ssh_sources  = ["0.0.0.0/0", "::/0"]
  http_sources = ["0.0.0.0/0", "::/0"]
}

# The region's account-default VPC, discovered at plan time. This package
# creates no VPC and pins no UUID: the droplet joins whatever `default-<region>`
# is, and the validator refuses digitalocean-vpc-uuid and digitalocean-vpc-cidr
# so desired state cannot quietly start owning one.
data "digitalocean_vpc" "default" {
  name = "default-ams3"
}

resource "digitalocean_droplet" "signoz" {
  # `name` is the console label and updates in place; cloud-init also sets the
  # guest hostname from it at creation, and a later rename never revisits that,
  # so a changed name takes effect on the next create rather than repairing a
  # running host. `region`, `image` and `vpc_uuid` are ForceNew: editing any of
  # them destroys the droplet and its disk. `size` alone resizes in place.
  name     = "signoz-digitalocean-optout"
  region   = "ams3"
  size     = "s-4vcpu-8gb"
  image    = "ubuntu-24-04-x64"
  vpc_uuid = data.digitalocean_vpc.default.id
  # SSH keys are ids or fingerprints already in the account, and ForceNew:
  # changing the key set destroys and recreates the droplet instead of
  # re-authorizing it. Rotation is a rebuild, never an edit on a machine whose
  # disk you intend to keep.
  ssh_keys = ["00000000"]
  # Wait for ssh before starting Ansible.
  connection {
    type = "ssh"
    user = "root"
    host = self.ipv4_address
  }
  provisioner "remote-exec" {
    inline = ["ls"]
  }
  lifecycle { prevent_destroy = true }
}

# The provider firewall is the load-bearing layer: 22 from the SSH sources, 80
# and 443 from the HTTP sources, nothing else. Ansible manages no ufw for these
# ports. A rule with no source is not "closed" to DigitalOcean but an API
# error, so the two HTTP rules are emitted only when there is a source to name;
# an empty http-sources list means no public HTTP at all.
resource "digitalocean_firewall" "signoz" {
  name        = "signoz-digitalocean-optout-firewall"
  droplet_ids = [digitalocean_droplet.signoz.id]
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = local.ssh_sources
  }
  # 443 carries both the UI and OTLP ingestion: Caddy routes /v1/{logs,traces,
  # metrics} to the collector behind a bearer token and everything else to the
  # SigNoz application, so the collector's own 4317/4318 never need a rule and
  # stay bound to loopback. Opening them would be an unauthenticated write path:
  # community-edition SigNoz has no ingestion keys of its own.
  dynamic "inbound_rule" {
    for_each = length(local.http_sources) > 0 ? ["80", "443"] : []
    content {
      protocol         = "tcp"
      port_range       = inbound_rule.value
      source_addresses = local.http_sources
    }
  }
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  lifecycle { prevent_destroy = true }
}

output "params" {
  value = {
    provider = "digitalocean"
    ip       = digitalocean_droplet.signoz.ipv4_address
    user     = "root"
    sudoer   = "root"
    name     = "signoz-digitalocean-optout"
  }
}
