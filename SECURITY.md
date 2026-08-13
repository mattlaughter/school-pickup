# Security

## Intended deployment model

Pickup is designed primarily for **LAN use** inside a school building. The walker and marshal
screens have no login of their own (by design, for shared tablets).

- Do **not** port-forward port 8888.
- Do **not** put a bare public reverse proxy in front of the app.
- For access from outside the building, use the **Cloudflare Tunnel + Access** pattern
  described below (Google Workspace domain restriction is the recommended identity layer).
- Treat the host network and your Access policies as the trust boundary.

## What is protected

| Feature | Protection |
|---------|------------|
| Roster import/export, settings, branding, backup/restore | Admin PIN (default `1234` — change immediately) + 12-hour bearer token |
| Walker / Marshal screens | Unauthenticated on the LAN (by design — shared tablets during a short window) |
| TV Display | Read-only; shows first + last name only |

## Data handled

Student first/last names, grade, hang-tag numbers, and optional notes. In the United States these are FERPA-covered educational records when tied to attendance. Equivalent privacy rules apply in other jurisdictions.

## Reporting issues

If you discover a vulnerability that could expose student data even on a properly firewalled LAN, please open a private security advisory on the repository or contact the maintainers.

## Remote access (Cloudflare Tunnel)

When the app needs to be reachable from outside the building, put an identity layer in front
of it. The recommended pattern for K-12 is:

**Cloudflare Tunnel + Cloudflare Access + Google Workspace OAuth restricted to your domain**
(or a specific Google Group).

- No inbound ports on the school firewall.
- Clean subdomain (e.g. `pickup.yourdistrict.org`).
- Only accounts on your Workspace domain (or Group) can reach the app.
- The existing Admin PIN continues to protect roster, settings, and backup/restore.

A bare public URL without Access is not supported — the walker and marshal screens have no
login of their own.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#9-remote-access-with-cloudflare-tunnel-recommended-pattern)
for setup steps and a checklist.
