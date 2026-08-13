# Pickup — Deployment on a Production Server

This is the from-scratch guide for standing Pickup up on a production VM. It assumes a
brand-new server and no prior setup.

The short version: it's one Docker container. Give it a small Linux VM with Docker installed,
`docker compose up -d --build`, open port 8888, done.

---

## 1. VM hardware requirements

This app is tiny. The workload is a few hundred students, under ten devices, about twenty
minutes a day. **Do not over-provision** — these numbers are real, not conservative placeholders.

| Resource | Minimum | Recommended | Notes |
|---|---|---|---|
| vCPU | 1 | 2 | 2 gives headroom for the OS + Docker with zero effort |
| RAM | 1 GB | 2 GB | The app idles around 80–120 MB; the rest is OS and cache |
| Disk | 8 GB | 20 GB | OS + Docker + years of SQLite data + backups. The database itself is measured in megabytes |
| Network | 1 | 1 | One NIC on the building LAN |

A 2 vCPU / 2 GB / 20 GB VM is the comfortable target and will never be stressed by this app.

## 2. Software requirements

| Layer | Requirement |
|---|---|
| Hypervisor | Any — VMware, Hyper-V, Proxmox, VirtualBox all fine (or bare metal / a mini PC) |
| Guest OS | **Ubuntu Server LTS (24.04 or 22.04)**, 64-bit. Debian 12 also works identically |
| Container runtime | **Docker Engine** + the **Docker Compose plugin** |
| Anything else | None. Node, SQLite, and every dependency live inside the container |

You do **not** install Node.js, SQLite, or any app dependency on the VM itself. The container
carries all of it. The only thing the host needs is Docker.

## 3. Provision the VM

1. Create the VM with the resources above.
2. Install **Ubuntu Server LTS**, 64-bit. A minimal install is fine; you don't need a desktop.
3. Set the timezone to your own: `sudo timedatectl set-timezone America/Chicago` (substitute
   your zone — this is what the nightly queue reset keys off). Match it in `docker-compose.yml`
   via the `TZ` environment variable.
4. Give it a **fixed address** — either a static IP on the VM or a DHCP reservation on the
   router keyed to its MAC. The TV panel and the staff tablets will point at this address, so it
   must not change. **Write the IP down**; it's the whole address of the app.

## 4. Install Docker

On Ubuntu, the official convenience script is the simplest correct path:

```bash
sudo apt-get update
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER          # run docker without sudo
# log out and back in once for that group change to take effect
docker --version                        # confirm it's installed
docker compose version                  # confirm the compose plugin is present
```

## 5. Deploy the app

1. Copy the `pickup` folder onto the VM (scp, a USB drive, or `git clone` — whatever's
   easiest). Put it somewhere durable like `/opt/pickup`.
2. Build and start it:

   ```bash
   cd /opt/pickup
   docker compose up -d --build
   ```

   The first build takes a few minutes while it compiles the SQLite driver. Later restarts are
   instant.
3. Confirm it's healthy:

   ```bash
   docker compose ps            # STATUS should say "healthy" after ~15 seconds
   curl http://localhost:8888/api/health
   ```

That's the whole deploy. The container is set to `restart: unless-stopped`, so it comes back on
its own after a reboot or a crash.

## 6. Open the firewall (only if the host firewall is on)

Ubuntu Server ships with `ufw` inactive, so often there's nothing to do. If it's enabled:

```bash
sudo ufw allow 8888/tcp
```

Keep this to the **building LAN only**. See the security note below.

## 7. First-run checklist

Do these in order the first time, before dismissal ever runs on it:

- [ ] Open `http://<server-ip>:8888/` from a staff device on the same network.
- [ ] Go to **Admin**, sign in with the default PIN `1234`.
- [ ] **Change the PIN** in Admin → Settings. (It ships as 1234 by design; this is the step
      that secures it.)
- [ ] Set the **Lane A / Lane B names** to match what your staff call them.
- [ ] In **Admin → Branding**, set your **app name, subtitle, logo, and colour scheme** (light
      and dark). This is where the app becomes *your* school's.
- [ ] Import the real roster (Admin → Import). Delete any sample rows first; the importer also
      skips rows marked `SAMPLE ROW`.
- [ ] **Download a backup** (Admin → Download backup) and save it off the server.
- [ ] Open `http://<server-ip>:8888/display` on the gym Android panel, go full screen, set the
      panel's sleep to Never.
- [ ] Do a dry run: enter a few tags on a tablet and confirm they appear on the panel within a
      second.

The system ships with an **empty roster** — there are no demo students on a fresh build. The
sample-data script exists only for testing and never runs unless someone runs it by hand.

## 8. Security note

Pickup holds protected student names (FERPA-covered in the US; equivalent rules elsewhere).

- **Do not port-forward 8888.** No public IP and no bare reverse proxy without an identity
  layer.
- On the LAN, Admin is PIN-protected; the walker, marshal, and display screens are open by
  design (shared tablets during a short window — see the README security section).
- For access from outside the building, use the Cloudflare Tunnel + Access pattern in the
  next section. Domain-restricted Google OAuth is the recommended way to put an identity
  boundary in front of the app without changing Pickup itself.

## 9. Remote access with Cloudflare Tunnel (recommended pattern)

Pickup itself has no per-user login on the walker and marshal screens — that is intentional for
shared tablets on a trusted LAN. When you need the app reachable from outside the building
(or from staff devices that are not on the school network), put an identity layer in front of
it. The combination that works well for K-12 is:

**Cloudflare Tunnel + Cloudflare Access + Google Workspace OAuth restricted to your domain.**

That stack gives you:

- No inbound ports opened on the school firewall (outbound-only tunnel).
- A clean subdomain (e.g. `pickup.yourdistrict.org`).
- Google sign-in that only accepts accounts on your Workspace domain (or a specific Group).
- The existing Admin PIN still protects roster, settings, and backup/restore.

With Access enforced, the unauthenticated screens are only reachable by people who already
passed your domain login. That is a solid, practical security boundary for school use.

### Prerequisites

- A Cloudflare account and a domain you control.
- Google Workspace (or Google Cloud Identity) as the identity provider in Cloudflare Access.
- The Pickup container already running and healthy on the LAN.

### Named tunnel on a subdomain

1. In the Cloudflare Zero Trust dashboard create a tunnel and install the connector
   (`cloudflared`) on the Pickup host. Cloudflare gives you a token or a config file.
2. Add a **Public Hostname** route:
   - Subdomain: e.g. `pickup`
   - Domain: your zone → results in `pickup.yourdistrict.org`
   - Service: `http://127.0.0.1:8888` (or the Docker service name if cloudflared is on the
     same Compose network)
3. Create a **Cloudflare Access** application for that hostname.
   - Identity provider: **Google**.
   - Policy: allow only emails on your Workspace domain (e.g. `*@yourdistrict.org`), or
     better, a specific Google Group such as “IT + office staff” or “dismissal team”.
   - Require Access on the entire hostname — do not leave any path public.

Example `config.yml` fragment:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json

ingress:
  - hostname: pickup.yourdistrict.org
    service: http://127.0.0.1:8888
  - service: http_status:404
```

### Docker Compose snippet (optional)

Run `cloudflared` as a second service next to Pickup:

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=your-token-from-cloudflare-dashboard
    # No ports published — outbound only
```

### Quick tunnel (one-off testing only)

For a temporary public URL that disappears when the process stops:

```bash
# Install cloudflared (Debian/Ubuntu example)
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

cloudflared tunnel --url http://127.0.0.1:8888
```

Even for a quick test, prefer attaching Access if the URL will be shared beyond a single
trusted person.

### Checklist

- [ ] Cloudflare Access is enforced on the full hostname (no public paths).
- [ ] Google OAuth is restricted to your Workspace domain (or a tighter Group).
- [ ] The Admin PIN has been changed from the default `1234`.
- [ ] Staff tablets and the gym display can still reach the app on the local LAN IP
      (tunnel is additive, not a replacement for local access).
- [ ] You have a named person who can revoke Access or disable the tunnel if needed.

### Notes on day-to-day use

- Local LAN access (tablets + TV at `http://<server-ip>:8888`) remains the lowest-latency,
  simplest path for the actual car line. Many schools keep both: LAN for dismissal, subdomain
  for remote admin or off-site demos.
- A leaked Access session or a misconfigured policy would expose student names and queue
  controls. Treat Access policy changes with the same care you give to other systems that
  hold student data.

## 10. Day-2 operations

| Task | Command / action |
|---|---|
| Update after a code change | `cd /opt/pickup && docker compose up -d --build` |
| Restart | `docker compose restart` |
| Watch logs | `docker compose logs -f` |
| Stop (data kept) | `docker compose down` |
| Back up the data | Admin → Download backup, **stored off the server** |
| Restore | Admin → Restore from file |

The only irreplaceable thing on this VM is the database, which lives in the `pickup-data`
Docker volume. Everything else — the OS, Docker, the app — can be rebuilt from scratch and this
folder. Take a VM snapshot after the first successful run, and keep copying the Admin backups
somewhere other than this VM.

## 11. Answer these before go-live

- [ ] What IP did the VM get, and is it reserved so it won't change?
- [ ] Where do the Admin backups get copied to (a file share, not this VM)?
- [ ] **Who is the named person responsible for this system?** Answer this one first.
