# Day 1 host work: Tailscale, then SSH

This is the part of Day 1 that happens on the VPS and not in the repository.
It is deliberately written as a procedure with a stop point, because §20 names
it as the most likely way this correction goes wrong:

> **One operational warning:** restrict SSH to Tailscale only after confirming
> Tailscale works and the provider's console recovery path is known. Locking
> yourself out of a box that holds the only copy of a running system is a
> self-inflicted outage.

Nothing in this file can be run from CI or from a development container. It
needs the VPS, a Tailscale auth key, and someone who can open the provider's
serial console if it goes wrong.

## 0. Before you touch SSH

Write these two things down somewhere that is not the box:

- The provider's console or rescue-mode path for this VPS, **tested once** —
  open it, confirm you get a prompt. An untested recovery path is not one.
- A second administrator who can reach the console if you cannot.

Do not continue until both are true.

## 1. Install Tailscale

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --auth-key "$TAILSCALE_AUTH_KEY" --hostname stenth-operator
```

The auth key is used once at provisioning and is **not stored on the box**
(§17). Delete it from your shell history afterwards.

Confirm, and record the interface address:

```sh
tailscale status
tailscale ip -4          # e.g. 100.x.y.z — this is what Caddy's private block binds
```

## 2. Confirm the private path works, from another device

From a second machine on the same tailnet:

```sh
ssh -o IdentitiesOnly=yes <user>@100.x.y.z        # must succeed
curl -fsS http://100.x.y.z:3000/api/health        # must return 200 with status: ok
```

Day 1's exit criterion is that second command returning green **over Tailscale**.
Until Day 9 adds the Caddy split, the private path is the Tailscale address
directly; from Day 9 it is Caddy's private site block on the same interface.

## 3. Only now, restrict SSH

With a second session already open and confirmed working — so a mistake is
recoverable without the console:

```sh
sudo ufw allow in on tailscale0 to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose
```

Then, and only then, close public SSH:

```sh
sudo ufw delete allow 22/tcp     # if a public rule exists
sudo ufw status verbose          # 22 must appear only on tailscale0
```

Verify from outside the tailnet that port 22 is closed, and verify from inside
that SSH still works, **before** you close the session you are holding open.

Host hardening from §17 belongs here too: key-only SSH, no root login,
fail2ban on SSH, unattended security upgrades. The public surface stays 80 and
443 only; the dashboard, the API and `/api/health` are never public (§20).

## What is still outstanding after this file

Day 9 owns the Caddy public/private split, so until then the dashboard is
private only because of ufw and Tailscale, not because of a 404 from a public
site block. That is the Day 9 exit criterion, not this one.
