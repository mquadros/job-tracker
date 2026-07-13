# Job Tracker

A self-hosted job application tracker. Track companies, roles, fit, pipeline stage,
resumes, and notes, with a dashboard, an insights/analytics page, and a Kanban board.
Built with Node.js, Express, SQLite, and vanilla JS (no frontend framework, no build
step). Docker-ready for any host, including TrueNAS/Portainer.
<img width="2110" height="1636" alt="image" src="https://github.com/user-attachments/assets/edc569ac-cce8-4c86-9faa-4d03ac3dced4" />

<img width="2116" height="1819" alt="image" src="https://github.com/user-attachments/assets/89dfb490-78c0-4c79-ab21-b2d74434d6d7" />

<img width="2113" height="1723" alt="image" src="https://github.com/user-attachments/assets/c2e6294f-de58-471c-b485-6561986bda7f" />

---

## Features

- **Dashboard**: searchable, filterable card view of every application
- **Insights**: daily-applications bar chart, pipeline funnel, and a breakdown donut
  chart (by stage, fit, location, or outcome), plus headline stats like response rate
- **Kanban board**: drag-and-drop cards between pipeline stages
- **Resume / cover letter uploads**: attach the actual file per application, download
  it back later
- **CSV export** of the current filtered view
- **Multi-user**: each user has an isolated, private job list, and an admin role can
  manage accounts
- **Dark mode**
- **Agent/automation access**: a personal API token unlocks either a Claude Code Skill
  (curl-based REST access) or a remote MCP server, so an AI agent can add/update/query
  your pipeline on your behalf. See [Agent access](#agent-access) below.

---

## Quick start (Docker)

### 1. Clone the repo

```bash
git clone https://github.com/mquadros/job-tracker.git
cd job-tracker
```

### 2. Build and run

```bash
docker compose up -d --build
```

Nothing to configure first. `ADMIN_PASS` and `JWT_SECRET` are both generated automatically
the first time the container starts, no editing `docker-compose.yml` required.

### 3. Get your admin password

```bash
docker logs job-tracker
```

Open `http://your-server-ip:3000` (or `http://localhost:3000` for local testing) and log in
with the admin credentials you set above.

If you'd rather set your own admin password (or your own `JWT_SECRET`) instead of using the
generated ones, uncomment and fill in the corresponding lines in `docker-compose.yml` before
first run.

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
- Each user has their own isolated job list, with no cross-user visibility.
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
below); without a `.env` file it uses `ADMIN_USER=admin`, generates an admin password and
prints it to the console on first run (same as the Docker image), and stores a local SQLite
file at `./data/tracker.db`.

---

## Environment variables

| Variable     | Default      | Description                              |
|--------------|--------------|------------------------------------------|
| `ADMIN_USER` | `admin`      | Username for the seeded admin account    |
| `ADMIN_PASS` | *(auto-generated)* | Password for the seeded admin account. If unset, a random one is generated on first boot and printed once to the container logs (`docker logs job-tracker`); only takes effect when the admin account is first created |
| `JWT_SECRET` | *(auto-generated)* | Secret for signing session JWTs. If unset, a random one is generated on first boot and saved to the data volume (`<DB_PATH dir>/.jwt-secret`) so it survives restarts; set your own if you want a specific value or are sharing one secret across multiple instances |
| `PORT`       | `3000`       | Port the server listens on               |
| `DB_PATH`    | `/app/data/tracker.db` (Docker) / `./data/tracker.db` (local) | Path to SQLite database file |
| `TRUST_PROXY` | `false` (unset) | Set to `true` only if this app is exclusively reachable through a reverse proxy. Enables Express's `trust proxy`, which the login rate limiter relies on to see real client IPs. Enabling this without an actual proxy in front lets clients spoof their IP via `X-Forwarded-For` and bypass rate limiting. |
| `COOKIE_SECURE` | `false` (unset) | Set to `true` once the app is served over HTTPS (e.g. behind the reverse proxy above). Marks the session cookie `Secure`, so browsers stop sending it over plain HTTP. Leave unset for a plain-HTTP LAN deployment, or the cookie won't be sent at all and login will silently fail. |

---

## Agent access

Each user can generate a personal API token (Profile → API access) that's scoped to the
jobs API only. It can never change your password, hit admin routes, or regenerate
itself. Two ways to use it:

- **`job-tracker` Claude Code Skill** (`.claude/skills/job-tracker/`): plain REST calls
  over `curl` (or any HTTP client). Works with any agent that has shell access.
- **Remote MCP server** (`POST /mcp`): a Streamable HTTP MCP server exposing
  `list_jobs`/`find_jobs`/`add_job`/`update_job`/`delete_job` as tools, for MCP-capable
  clients that don't have shell access. Requires the job-tracker instance to be
  network-reachable from wherever the client runs.

Both authenticate the same way with the same token. In practice, the **Claude Code CLI**
(`claude mcp add --transport http job-tracker http://<host>:3000/mcp --header "Authorization:
Bearer <token>"`) is the supported MCP client for this endpoint. Claude Desktop's native
"Add custom connector" UI and the `mcp-remote` bridge both require OAuth, which this app
doesn't implement (just the bearer token), so neither can complete their auth handshake
against it. Use the Skill or Claude Code's MCP support; other MCP clients that support a
plain static bearer header (rather than requiring OAuth) should also work, but haven't
been tested here.

---

## Contributing

Issues and pull requests are welcome. This is a small, dependency-light codebase on
purpose (no frontend framework, no bundler). If you're adding a feature, try to match
that footprint rather than introducing new build tooling.

## License

[MIT](LICENSE)
