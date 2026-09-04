terraform {
  required_providers {
    vultr = { source = "vultr/vultr", version = "~> 2.0" }
  }
}

provider "vultr" {
  # api key comes from VULTR_API_KEY in the environment
}

locals {
  ssh_sources  = ["0.0.0.0/0", "::/0"]
  http_sources = ["0.0.0.0/0", "::/0"]
}

resource "vultr_firewall_group" "signoz" {
  description = "signoz-optout-firewall"
}

resource "vultr_firewall_rule" "ssh" {
  for_each          = toset(local.ssh_sources)
  firewall_group_id = vultr_firewall_group.signoz.id
  protocol          = "tcp"
  port              = "22"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}

resource "vultr_firewall_rule" "http" {
  for_each          = toset(local.http_sources)
  firewall_group_id = vultr_firewall_group.signoz.id
  protocol          = "tcp"
  port              = "80"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}

# 443 carries both the UI and OTLP ingestion: Caddy routes /v1/{logs,traces,
# metrics} to the collector behind a bearer token and everything else to the
# SigNoz application, so the collector's own 4317/4318 never need a rule and
# stay bound to loopback. Opening them would be an unauthenticated write path:
# community-edition SigNoz has no ingestion keys of its own.
resource "vultr_firewall_rule" "https" {
  for_each          = toset(local.http_sources)
  firewall_group_id = vultr_firewall_group.signoz.id
  protocol          = "tcp"
  port              = "443"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}

resource "vultr_instance" "signoz" {
  # `label` is the console name and updates in place. There is deliberately no
  # `hostname`: Vultr implements a hostname change as an OS reinstall, so the
  # provider marks that attribute ForceNew, and editing vultr-name would
  # destroy the instance and its disk rather than rename it.
  label             = "signoz-optout"
  region            = "ams"
  plan              = "vc2-4c-8gb"
  os_id             = 2284
  firewall_group_id = vultr_firewall_group.signoz.id
  # SSH keys are ids already in the account, and ForceNew: changing the key set
  # destroys and recreates the instance instead of re-authorizing it. Rotation
  # is a rebuild, never an edit on a machine whose disk you intend to keep.
  ssh_key_ids = ["00000000-0000-0000-0000-000000000000"]
  # Wait for ssh before starting Ansible.
  connection {
    type = "ssh"
    user = "root"
    host = self.main_ip
  }
  provisioner "remote-exec" {
    inline = ["ls"]
  }
  lifecycle { prevent_destroy = true }
}

output "params" {
  value = {
    provider = "vultr"
    ip     = vultr_instance.signoz.main_ip
    user   = "root"
    sudoer = "root"
    name   = "signoz-optout"
  }
}
