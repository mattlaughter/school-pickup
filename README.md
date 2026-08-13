# Pickup

**Open-source, self-hosted two-lane car-line dismissal board for schools.**

One staff member walks the line entering hang-tag numbers. A TV inside shows which students should walk out to which lane. A marshal at the curb taps kids off as they get in their cars.

Built for schools that run **two pickup lanes**, with students grouped into waves that match numbered, coloured waiting spots on the ground.

Everything runs in **one Docker container**. No second service, no build step for the frontend, no cloud account required for day-to-day use.

```bash
docker compose up -d --build
# Staff app:  http://<server-ip>:8888/
# TV display: http://<server-ip>:8888/display
```

Default admin PIN is `1234` — **change it** before go-live.

---

## Features

- **Line Walker** — numeric keypad, offline queue, rejects unknown/duplicate tags with clear reasons
- **Marshal** — per-lane loading view, tap students into the car, one-tap “Release all” for the front group
- **TV Display** — read-only dual-lane board for the gym / lobby panel
- **Admin** — PIN-protected roster import/export, branding, settings, backup/restore, activity log
- **Sibling-aware grouping** — families stay together; spots renumber automatically when cars leave
- **Coloured waiting spots** — up to 6 numbered spots per lane (colour + number for colour-blind clarity)
- **Branding** — school name, logo, full light/dark colour scheme from the UI (no code edits)
- **Single container** — SQLite, Express, WebSockets; one volume to back up

---

## Quick start

```bash
git clone https://github.com/mattlaughter/school-pickup.git
cd pickup
docker compose up -d --build
```

| Screen | URL |
|--------|-----|
| Staff app (walker, marshal, admin) | `http://<server-ip>:8888/` |
| TV display | `http://<server-ip>:8888/display` |

Find the server IP with `ip addr` (Linux) or `ipconfig` (Windows).

### Sample data

```bash
docker compose exec pickup node seed.js
```

Loads ~59 synthetic students across 48 hang tags (including sibling families). Refuses to run if a real roster already exists.

### Make it yours

In **Admin → Branding** (no code changes):

- App name and subtitle
- Logo (appears on staff app, TV, and browser tab)
- Full colour scheme for light and dark mode

Full production checklist, VM sizing, and firewall notes: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

---

## How the four screens work

**Line Walker** — Walk the car line, type each hang tag, press Enter. Unknown tags and duplicates are rejected immediately. If Wi-Fi drops, entries stay on the device and sync when it reconnects.

**Marshal** — Shows the cars currently loading in one lane with each child’s name and spot number. Tap children as they get in. When the last sibling is in, the car releases and the queue advances. “Release all” clears the whole front group in one tap.

**TV Display** — Two lanes side by side: loading group + upcoming waves. Read-only. Intended for a dedicated panel in the gym or lobby.

**Admin** — PIN protected. Roster import/export (CSV), add/delete students, settings, branding, backup/restore, activity log.

### Coloured waiting spots

Each lane has up to six physical spots. Every child in the **Loading now** group gets a matching coloured + numbered dot. Siblings take consecutive spots. Spots re-flow when cars leave so nobody is left standing on an empty higher number.

| Spot | 1 | 2 | 3 | 4 | 5 | 6 |
|------|---|---|---|---|---|---|
| Colour | green | orange | yellow | blue | purple | red |

“Names per group” is capped at 6 in Settings because there are only six painted spots.

---

## Security & privacy

Pickup stores student first/last names and hang-tag numbers. In the US these are FERPA-covered educational records when tied to attendance.

**Recommended day-to-day model:** run it on the school LAN only. Tablets and the TV talk to `http://<server-ip>:8888`. No inbound ports from the internet.

**If you need access from outside the building** (remote admin, demos, staff not on the LAN):

> **Cloudflare Tunnel + Cloudflare Access + Google Workspace OAuth restricted to your domain** (or a tighter Google Group)

That puts an identity layer in front of the app on a subdomain (e.g. `pickup.yourdistrict.org`) without opening ports on the school firewall. The walker/marshal screens still have no login of their own — Access is what keeps the public out.

- Do **not** port-forward 8888.
- Do **not** put a bare public reverse proxy in front of the app.
- Change the default Admin PIN immediately.

Full setup steps and checklist: **[docs/DEPLOYMENT.md §9](docs/DEPLOYMENT.md#9-remote-access-with-cloudflare-tunnel-recommended-pattern)**.  
Threat model summary: **[SECURITY.md](SECURITY.md)**.

---

## Documentation

| Doc | Purpose |
|-----|---------|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production VM, Docker, first-run checklist, Cloudflare Tunnel |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why it is built this way — read before changing behaviour |
| [SECURITY.md](SECURITY.md) | Trust boundary, Access pattern, data handling |
| [docs/Pickup-Student-Import-Template.xlsx](docs/Pickup-Student-Import-Template.xlsx) | CSV import template |

Architecture overview deck: `Pickup-Overview.pptx` (in the repo root).

---

## Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js 20 |
| HTTP + static | Express |
| Realtime | `ws` (raw WebSockets) |
| Database | SQLite via `better-sqlite3` (one file) |
| Frontend | Vanilla JS, no build step |
| Deploy | Docker Compose, single service |

Design goals: boring, small, maintainable by the next person who inherits it. See `docs/ARCHITECTURE.md` for the deliberate refusals (no frontend framework, full-state broadcast instead of diffs, etc.).

---

## License

[MIT](LICENSE)

---

## Contributing / maintaining

There is no formal contribution process yet. If you run this at a school and hit a real gap, open an issue or PR.

Before changing behaviour, read **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — especially the sync model and the two rules encoded in the code (one tag per lane; families never split across Loading / Next Up).

Minimum smoke test after a code change: seed a fresh database, open the staff app in two browser windows plus the display in a third, and confirm that adding a tag in one window appears in the others within a second.
