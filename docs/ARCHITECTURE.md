# Pickup — Architecture & Handoff Decisions

> **Read this first if you inherited this system.** Section 8 is the runbook. Sections 1–2
> explain why it's built the way it is, which matters more than it sounds — most of the
> decisions here were made to keep you from needing to understand the rest.

---

## 1. What this system does

Two-lane car line dismissal. A staff member walks the car line entering hang tag numbers; a
TV in the building shows which students should be walking out to which lane; a marshal at the
curb taps students off as they get in their cars.

**Scale:** a few hundred students, under ten simultaneous devices, roughly twenty minutes a
day, ~180 school days a year.

That scale is the single most important fact in this document. Nothing here needs to be
clever. Almost every design decision below is a deliberate refusal to be clever.

---

## 2. Guiding constraints

| Constraint | Consequence |
|---|---|
| **Someone other than the original author will maintain this** | Boring, standard, small, documented. No framework the next person has to learn first. |
| **Failure is highly visible** | 2:45pm in a parking lot with 40 cars. Must degrade gracefully, never blank. |
| **Student data stays in the building** | On-premise. Student names tied to attendance are protected education records (FERPA in the US; equivalent rules elsewhere). |
| **Near-zero budget** | Open source, existing hardware, no recurring vendor cost. |
| **Runs ~20 min/day** | Uptime requirements are modest, but those 20 minutes are non-negotiable. |

---

## 3. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js LTS** | Ubiquitous. Any developer can read it. |
| HTTP + static | **Express** | The most boring, most documented web framework in existence. |
| Realtime | **`ws` (raw WebSockets)** | ~20 lines. No Socket.IO, no message broker, no subscription library. |
| Database | **SQLite via `better-sqlite3`** | One file. Backup is a file copy. Restore is a file copy. |
| Frontend | **Vanilla JS, no build step** | The single biggest handoff win — see 3.1. |
| Deployment | **Docker Compose, one service** | `docker compose up -d`. Moving to a new box is copying two files. |
| Host OS | **Ubuntu Server LTS on a VM** | See section 4. |

### 3.1 Why no frontend framework

The app is roughly 2,000 lines. With vanilla JS served as static files there is **no build
step** — no npm install on the frontend, no bundler, no `node_modules` archaeology, no
toolchain that rots. You edit a `.js` file and refresh the browser.

The next maintainer can open the file and read it. If this were React, they would first need
to learn React, then install a toolchain that may no longer build cleanly in three years. That
trade is worth far more than the ergonomics a framework would buy on an app this size.

If the app ever grows past ~5,000 lines, revisit this. It won't.

---

## 4. Where it runs

**Recommended: a VM on infrastructure you already run** rather than new hardware.

If you already run a hypervisor (VMware, Hyper-V, Proxmox — any), a VM means no new physical
device to fail, snapshots before every change, and backups that ride along with whatever you
already do for other VMs. A dedicated mini PC (an Intel N100 box, ~$150) is a fine second choice
if you'd rather it be physically independent of the rest of the infrastructure — but then it's
one more thing with a fan.

**Resources:** 1 vCPU, 1 GB RAM, 10 GB disk. This is not a typo. The workload is a few hundred
rows and a websocket broadcast every few seconds.

**Networking:**

- Give it a **reserved DHCP lease or static IP** on the building LAN.
- Optionally add an internal DNS record, e.g. `pickup.example.local` (or whatever matches your
  naming scheme). It works fine with just the IP address, too.
- **Do not port-forward this to the internet.** See section 7.

---

## 5. Sync design — the only interesting problem

Everything else is CRUD. This is the part worth understanding.

### The approach: server is authoritative, broadcast full state

1. A client (walker, marshal, admin) sends a **mutation** over WebSocket: `ADD_TAG`,
   `TOGGLE_STUDENT`, `RELEASE_GROUP`, `MOVE_ENTRY`.
2. The server applies it to SQLite in a transaction.
3. The server broadcasts **the entire current queue state** to every connected client.
4. Every client re-renders from that state.

### Why broadcast everything instead of diffs

The full state for both lanes is on the order of **5 KB of JSON**. At a maximum of ten clients
and a few mutations per second, that is nothing.

Sending diffs would require sequence numbers, gap detection, and resync logic — meaning
conflict resolution, and a class of bug that only appears under load in the parking lot at
2:45pm. Broadcasting everything makes an entire category of bug impossible. **Take the
bandwidth, skip the bugs.**

Branding (colours, logo, app name) rides this same broadcast, so a change in Admin restyles
every screen live without a reload. The logo bytes are the one thing not broadcast — only a
short version token is, and clients fetch the image from `/api/branding/logo`.

### Concurrency

Two walkers entering tags simultaneously is fine: the server applies mutations in the order it
receives them and appends to the queue. There is no merge, because there is nothing to merge —
queue position is simply arrival order at the server.

### Client resilience

Each client keeps the last known good state in memory and in `localStorage`.

- **Connection drops:** the client keeps rendering the last state it received and shows a
  small "reconnecting" indicator. The TV never goes blank.
- **Reconnect:** the client requests a full state refresh. No replay, no catch-up log.
- **Walker offline:** tag entries queue locally and flush on reconnect, in order.

The TV display is read-only, which makes it the easiest client to keep alive — it never needs
to send anything.

---

## 6. Data model

```
families        tag TEXT PRIMARY KEY, notes TEXT
students        id INTEGER PK, tag TEXT FK, first TEXT, last TEXT,
                grade TEXT, notes TEXT, active INTEGER
queue           id INTEGER PK, lane TEXT, tag TEXT FK,
                added_at INTEGER, added_by TEXT
queue_students  queue_id FK, student_id FK, in_car INTEGER
events          id INTEGER PK, at INTEGER, actor TEXT, kind TEXT, detail TEXT
settings        key TEXT PRIMARY KEY, value TEXT
```

**Key rules, encoded as constraints where possible:**

- A hang tag belongs to exactly one family. Siblings share a tag — that is the whole reason
  `families` exists as a separate table.
- A tag may appear in **at most one lane at a time** (unique index on `queue.tag`).
- `queue` is cleared nightly. `families` and `students` persist across the year.
- `events` is the audit trail — who dismissed whom, and when. Keep it. It is the first thing
  anyone asks for after an incident.
- `settings` holds configuration, including branding (app name, subtitle, per-theme colour
  palettes, and the uploaded logo), so a single database backup restores the whole look too.

**Display grouping rule:** groups are filled to a configured size (default 6 name slots per
lane) and **a family is never split across "Loading Now" and "Next Up."** If the next car has
three children and only two slots remain, that family moves to the next group and the current
group shows four. Splitting siblings across groups would strand a car at the curb.

---

## 7. Security posture

This is a LAN-only application holding protected student records. The posture is deliberately
simple, and it depends on one assumption.

- **The app is not reachable from the internet.** No port forward, no reverse proxy to the
  outside. This assumption is doing a lot of work — if it ever stops being true, the auth model
  below is no longer adequate and needs real accounts before exposure.
- **Admin functions are behind a PIN.** Roster import, student edits, settings, branding.
- **Walker and marshal screens are unauthenticated** on the LAN. They are operationally
  useless to an outsider and adding logins to a tablet that several staff share during a
  twenty-minute window creates more risk (shared passwords on sticky notes) than it removes.
- **The display screen is read-only** and exposes only first name and last name —
  the same information already visible to anyone standing in the car line.
- **HTTPS is not required on an isolated LAN** but is worth adding if the network is shared
  with student devices. A self-signed cert is adequate; devices are managed.

**Do not** put this on a public IP "temporarily to test something." That is how student data
incidents happen.

---

## 8. Runbook

### Daily operation

Nothing. The queue clears itself at midnight (local time — set the container's `TZ`). Staff
open the app and use it.

### Starting / stopping / restarting

```bash
cd /opt/pickup
docker compose up -d        # start (also: start on boot, restart policy is 'unless-stopped')
docker compose restart      # restart after a config change
docker compose logs -f      # watch logs
docker compose down         # stop
```

### Where things live

| Thing | Path |
|---|---|
| Application | `/opt/pickup` |
| Database (the only irreplaceable file) | `/opt/pickup/data/pickup.db` (or the `pickup-data` volume) |
| Nightly backups | `/opt/pickup/backups/pickup-YYYY-MM-DD.db` |
| Logs | `docker compose logs` |

### Backups

A nightly cron running `sqlite3 data/pickup.db ".backup backups/pickup-$(date +%F).db"` keeping
30 days is a reasonable baseline. **Copy these somewhere off the box** — a file share, NAS, or
cloud drive. A backup living on the same VM as the database is not a backup.

### Restore

```bash
docker compose down
cp backups/pickup-2026-05-14.db data/pickup.db
docker compose up -d
```

Or use Admin › Restore from file, which validates the upload and keeps the replaced database as
a safety copy.

### Start-of-year roster load

1. Export students from your student information system (SIS) with: hang tag, last name, first
   name, grade.
2. Open the app → Admin (PIN) → Import.
3. Drop the CSV. **Review the preview** — it reports counts and lists every rejected row with a
   reason. Nothing is written until you confirm.
4. Choose **Replace entire list** for a new school year.
5. Export a backup afterward from the same screen.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| TV shows names but they're stale | Display lost its websocket | Refresh the browser. Check the "reconnecting" indicator. |
| TV is blank | Browser closed or VM down | Check `docker compose ps`, then relaunch the kiosk browser. |
| Walker: "not on the rider list" | Student not imported, or tag typo | Admin → search the roster for the family. |
| Nobody can reach the app | VM or network | Ping the host. Then `docker compose ps` on the VM. |

### TV setup

A cheap stick PC or Raspberry Pi running Chromium in kiosk mode:

```bash
chromium-browser --kiosk --incognito http://<server-ip>:8888/display
# or, if you added a DNS name:  http://pickup.example.local/display
```

Disable screen blanking and set it to launch on boot.

---

## 9. Deliberately not built

Recording these so the next person doesn't assume they were forgotten.

- **Parent-facing app / parent check-in.** Big scope increase, and the hang tag system already
  works. Revisit only if parents ask.
- **Bus dismissal.** This system is car line only. Buses run on a different model.
- **Automated SIS sync.** Start-of-year CSV import is a 10-minute annual task. An automated
  integration is a permanent maintenance obligation to save 10 minutes a year.
- **Cloud hosting / multi-school tenancy.** One building per instance, on-prem, by design. If a
  second school adopts this, run a second instance before you build tenancy.
- **Per-staff user accounts.** See section 7 for the reasoning.

---

## 10. Open questions to answer before go-live

- [ ] Which VM host, and who has access to it?
- [ ] Internal DNS name (if any)?
- [ ] Where do nightly backups get copied to?
- [ ] Who is the named backup person for this system? *(Answer this one first.)*
- [ ] Does the TV location have wired ethernet, or is it on wifi?
