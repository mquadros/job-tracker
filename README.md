# Job Tracker

A self-hosted job application tracker. Track companies, roles, fit, pipeline stage,
resumes, and notes — with a dashboard, an insights/analytics page, and a Kanban board.
Built with Node.js, Express, SQLite, and vanilla JS (no frontend framework, no build
step). Docker-ready for any host, including TrueNAS/Portainer.

---

## Features

- **Dashboard** — searchable, filterable card view of every application, with live stats
- **Insights** — daily-applications bar chart, pipeline funnel, and a breakdown donut
  chart (by stage, fit, location, or outcome)
- **Kanban board** — drag-and-drop cards between pipeline stages
- **Resume / cover letter uploads** — attach the actual file per application, download
  it back later
- **CSV export** of the current filtered view
- **Multi-user** — each user has an isolated, private job list; an admin role can manage
  accounts
- **Dark mode**
- **Agent/automation access** — a personal API token unlocks either a Claude Code Skill
  (curl-based REST access) or a remote MCP server, so an AI agent can add/update/query
  your pipeline on your behalf. See [Agent access](#agent-access) below.

---

## Quick start (Docker)

### 1. Clone the repo

```bash
git clone https://github.com/mquadros/job-tracker.git
cd job-tracker
```

### 2. Configure environment

Edit `docker-compose.yml` before first run:

```yaml
ADMIN_USER: admin           # your admin username
ADMIN_PASS: changeme        # your initial admin password
JWT_SECRET: <random string> # generate with: openssl rand -hex 32
```

### 3. Build and run

```bash
docker compose up -d --build
```

Open `http://your-server-ip:3000` and log in with the admin credentials you set above.

> **Change your password** after first login — click your username (top right) to open
> the Profile menu.

---

## Deploying via Portainer

1. Copy the project folder to your host, or use Portainer's Git integration pointed at
   `https://github.com/mquadros/job-tracker.git`.
2. In Portainer → **Stacks** → **Add stack** → paste or upload the `docker-compose.yml`.
3. Set the environment variables in the Portainer UI (preferred over editing the yaml
   directly).
4. Deploy. The stack will build the image and start the container.
5. Map a host port under **Ports** if you want something other than 3000.

### Recommended: put it behind a reverse proxy

Use Nginx Proxy Manager, Caddy, or Traefik to add HTTPS. Point your proxy at
`job-tracker:3000`.

---

## User management

- **Admin users** can create, view, and remove other users from the user-management
  section at the bottom of their Profile modal.
- Each user has their own isolated job list — no cross-user visibility.
- Passwords are hashed with bcrypt (cost factor 12). JWTs are stored in an httpOnly
  cookie and expire after 7 days.

---

## Data

SQLite database is stored at `/app/data/tracker.db` inside the container, mounted to the
`job-tracker-data` named volume. Uploaded resumes/cover letters live alongside it under
`/app/data/uploads/`. Back both up by copying the volume contents out:

```bash
docker cp job-tracker:/app/data ./job-tracker-data-backup
```

---

## Local development

```bash
npm install
npm run dev   # uses node --watch for auto-reload
```

The dev server reads the same environment variables as the Docker image (see table
below); without a `.env` file it falls back to `ADMIN_USER=admin`,
`ADMIN_PASS=changeme`, an insecure default `JWT_SECRET`, and a local SQLite file at
`./data/tracker.db`. Don't use these defaults for anything internet-reachable.

---

## Environment variables

| Variable     | Default      | Description                              |
|--------------|--------------|------------------------------------------|
| `ADMIN_USER` | `admin`      | Username for the seeded admin account    |
| `ADMIN_PASS` | `changeme`   | Password for the seeded admin account    |
| `JWT_SECRET` | *(none — required)* | Secret for signing JWTs. **The app refuses to start without this set** — generate one with `openssl rand -hex 32` |
| `PORT`       | `3000`       | Port the server listens on               |
| `DB_PATH`    | `/app/data/tracker.db` (Docker) / `./data/tracker.db` (local) | Path to SQLite database file |
| `TRUST_PROXY` | `false` (unset) | Set to `true` only if this app is exclusively reachable through a reverse proxy — enables Express's `trust proxy`, which the login rate limiter relies on to see real client IPs. Enabling this without an actual proxy in front lets clients spoof their IP via `X-Forwarded-For` and bypass rate limiting. |
| `COOKIE_SECURE` | `false` (unset) | Set to `true` once the app is served over HTTPS (e.g. behind the reverse proxy above) — marks the session cookie `Secure`, so browsers stop sending it over plain HTTP. Leave unset for a plain-HTTP LAN deployment, or the cookie won't be sent at all and login will silently fail. |

---

## Agent access

Each user can generate a personal API token (Profile → API access) that's scoped to the
jobs API only — it can never change your password, hit admin routes, or regenerate
itself. Two ways to use it:

- **`job-tracker` Claude Code Skill** (`.claude/skills/job-tracker/`) — plain REST calls
  over `curl` (or any HTTP client). Works with any agent that has shell access.
- **Remote MCP server** (`POST /mcp`) — a Streamable HTTP MCP server exposing
  `list_jobs`/`find_jobs`/`add_job`/`update_job`/`delete_job` as tools, for MCP-capable
  clients that don't have shell access. Requires the job-tracker instance to be
  network-reachable from wherever the client runs.

Both authenticate the same way with the same token. In practice, the **Claude Code CLI**
(`claude mcp add --transport http job-tracker http://<host>:3000/mcp --header "Authorization:
Bearer <token>"`) is the supported MCP client for this endpoint. Claude Desktop's native
"Add custom connector" UI and the `mcp-remote` bridge both require OAuth, which this app
doesn't implement (just the bearer token) — neither can complete their auth handshake against
it. Use the Skill or Claude Code's MCP support; other MCP clients that support a plain static
bearer header (rather than requiring OAuth) should also work, but haven't been tested here.

---

## Contributing

Issues and pull requests are welcome. This is a small, dependency-light codebase on
purpose (no frontend framework, no bundler) — if you're adding a feature, try to match
that footprint rather than introducing new build tooling.

## License

[MIT](LICENSE)
