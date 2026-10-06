# Open deviations from SPEC.md §20, awaiting a decision

Two things about the target host conflict with the specification as written.
Neither is solved here, because neither should be solved quietly. Both are
recorded with the options and a recommendation, and nothing in the repository
depends on the outcome yet.

The target is **stenth-engine**, 139.84.205.53, Vultr Melbourne, Ubuntu 24.04,
2 vCPU / 4 GB / 75 GB. It is **shared**: `/opt/stenth` runs `stenth-caddy-1`,
`stenth-n8n-1` and `stenth-n8n-clients-1`, and the clients instance is
production for a paying client.

---

## 1. Ports 80 and 443 are already taken

§20 says Caddy is "the only container with published host ports" and runs two
site blocks: a public one serving `/optout/*` and the ACME challenge, and a
private one on the Tailscale interface proxying the dashboard.

The existing Caddy already publishes 80 and 443 on the public interface, and
its Caddyfile is not ours to edit. So Operator's Caddy cannot be what §20
describes.

**This is not blocking.** The private dashboard is Day 9 and `/optout/:token`
is Day 7. Day 1 needs no ingress at all — nothing in `docker-compose.yml`
publishes 80 or 443, and the web container binds loopback only.

The private half has an answer that conflicts with nothing: Operator's Caddy
binds the **Tailscale interface** (`100.x.y.z:443`), not the public one. Two
processes can both listen on port 443 on different addresses. The existing
Caddy binds the public interface; Operator's binds the tailnet. No contention,
no edit to the live Caddyfile, and §20's "dashboard reachable over Tailscale
only" is satisfied exactly.

The public half — one URL that recipients must be able to open from any
device — is the open question.

| Option | How | Cost | Risk |
|---|---|---|---|
| **A. Cloudflare Tunnel** (recommended) | A `cloudflared` container in Operator's Compose project, outbound-only, serving `optout.<sending-domain>` straight to the web container | Free tier | A dependency on Cloudflare for one endpoint. No inbound port, so nothing to contend for and no ACME challenge needed — Cloudflare terminates TLS |
| **B. A second public IP** | Add a Vultr reserved IP, bind Operator's Caddy to it on 80/443, ACME as §20 describes | A few dollars a month | Most faithful to §20. One more thing to configure correctly, and the two Caddies must each bind a specific address rather than `0.0.0.0` — which means confirming the existing one is not already wildcard-bound |
| **C. One site block in the existing Caddyfile** | `handle /optout/* { reverse_proxy … }` in the live config | Free | Lowest complexity, highest blast radius. A reload touches the paying client's ingress. Currently excluded by instruction |

**Recommendation: A.** It needs no port, no new IP and no change to anything
the paying client depends on, which is the property that matters most on a
shared box. B is the better long-term shape if a second IP is acceptable.

**Decision needed before Day 7.** Until then this file is the record.

---

## 2. The host holds mail credentials; Operator does not

§1 and §14 say the deployment holds no mail-sending credential of any kind,
and §23 makes that a structural assertion rather than a promise. On a dedicated
box that is literally true. On this box it is not: the existing n8n stack holds
mail credentials, and that is known and accepted.

So the guarantee has a precise scope, and it is worth writing down precisely
rather than letting a future reader assume more than it says.

**What still holds, and is tested:**

- No mail-capable package in Operator's dependency tree — `npm run lint`
  (`scripts/lint-no-mail.mjs`) checks the resolved lockfile, not just
  `package.json`, and runs in CI on every commit.
- No Operator source file imports one, and `gmail.compose` appears nowhere in
  `src/`.
- No mail credential in Operator's `.env`, `.env.example`, environment or
  database schema — `001_init.sql` has no table, column or type for one, and a
  test asserts it.
- Operator's containers get no mail credential and no access to the other
  stack's: separate Compose project, separate network, separate `.env`.

**What does not hold, and why it is accepted:** an attacker with root on the
host reaches n8n's mail credentials. That is true whether or not Operator is
installed, so Operator's presence does not change that exposure — but it does
mean the sentence "the worst case for a compromised VPS is read access to
prospect research and the ability to burn model budget" (§17) is no longer true
of **this host**. It remains true of Operator.

The honest version for this deployment: *Operator cannot send mail, and no
compromise of Operator yields a mail credential. The host is a shared box whose
other tenant can.*

No action requested. Recorded so the claim is not overstated later.
