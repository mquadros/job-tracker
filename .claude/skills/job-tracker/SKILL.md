---
name: job-tracker
description: Update or query a self-hosted job-tracker dashboard's data via its REST API instead of asking the user to click through the UI. Use this whenever the user mentions adding a job application, a company/role they're applying to or interviewing with, changing an application's status ("mark X as Interview", "I heard back from Y", "add an offer from Z"), fit/gap notes, resume filenames, or asks what's in their pipeline ("what's my status on Toast?", "list my active applications", "how many strong-fit roles do I have?"), even if they don't say "job tracker" or name the app explicitly. Also use it to remove an application they've withdrawn or no longer want tracked.
---

# job-tracker dashboard updates

This drives a self-hosted job-tracker app (Express + SQLite) directly through its REST API
using plain HTTP requests. It doesn't require Claude Code, PowerShell, or any bundled
script, just the ability to make an HTTP request with a custom header and a JSON body,
however your environment does that (a shell with `curl`, a Python HTTP client, `fetch`,
etc.). The examples below use `curl` as a universal reference; translate the same
method/path/header/body to whatever tool you actually have.

## One-time setup

You need two things: a **base URL** and a personal **API token**.

1. Ask the user for the server's **location** and **port** if you don't already have them,
   then combine them into a base URL. Don't just ask for a raw URL, since that leaves the
   host ambiguous when someone has more than one instance running (e.g. a local dev copy vs.
   a self-hosted deployment). Ask specifically:
   - **Location**: `localhost` for an instance running on the same machine, or the
     remote address (IP or hostname) of a self-hosted deployment otherwise.
   - **Port**: defaults to `3000` unless they say otherwise.

   Combine as `http://<location>:<port>` (or `https://` if they tell you it's behind TLS).
   If the user has multiple instances they use regularly, ask which one they mean for this
   request rather than assuming, and consider storing each under a distinct name in `.env`
   (e.g. `JOB_TRACKER_URL_LOCAL`, `JOB_TRACKER_URL_REMOTE`) so you don't have to ask every
   time.
2. Ask the user to generate a token: in the app, click their username (top right), then
   **API access**, then **Generate token**. It's shown once, so ask them to paste it to you
   right after generating it. Don't ask them to go dig it up later, since it won't be
   recoverable.
3. If your environment persists files across turns (e.g. you're working in a local project
   directory), store the URL and token in a `.env` file next to the project so you don't have
   to ask again next time:
   ```
   JOB_TRACKER_URL=http://localhost:3000
   JOB_TRACKER_TOKEN=jt_...
   ```
   If the user has more than one instance, use suffixed names instead (`_LOCAL`/`_REMOTE`, or
   whatever distinguishes them) and ask which pair to use whenever it's not obvious from
   context:
   ```
   JOB_TRACKER_URL_LOCAL=http://localhost:3000
   JOB_TRACKER_TOKEN_LOCAL=jt_...
   JOB_TRACKER_URL_REMOTE=http://<remote-address>:3000
   JOB_TRACKER_TOKEN_REMOTE=jt_...
   ```
   Keep it out of version control (add `.env` to `.gitignore`); it's a live credential,
   equivalent to a password for the jobs API. If your environment doesn't persist files
   across sessions, just hold the URL/token in conversation context and ask again next time.

Don't echo the token back into chat once you have it. The token is scoped server-side to
the jobs API only. It cannot change the account password, read other users' data, or
touch admin routes even if it leaked, so there's no special handling needed beyond the
usual "don't print secrets you don't have to."

## Making requests

Every call is a plain HTTP request to `<base_url><path>` with header
`Authorization: Bearer <token>`. No login step, no session/cookie, and no rate limit to
worry about (this auth path never touches the app's login endpoint, which is the one
that's rate-limited).

```bash
curl -s "$JOB_TRACKER_URL/api/jobs" \
  -H "Authorization: Bearer $JOB_TRACKER_TOKEN"
```

POST/PATCH requests send a JSON body:

```bash
curl -s -X POST "$JOB_TRACKER_URL/api/jobs" \
  -H "Authorization: Bearer $JOB_TRACKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"company":"Airbnb","title":"Sr Manager Analytics","fit":"strong","fit_label":"Strong"}'
```

## Actions

**List all jobs**: `GET /api/jobs`. Use to answer status questions or to find an id before
an update/delete.

**Find a specific job**: there's no server-side search endpoint. Fetch the full list and
filter it yourself: case-insensitive substring match against `company` + `title`. Do this
whenever the user names a specific company/role, rather than trying to guess an id. If
nothing matches, try a shorter/looser fragment before giving up. If more than one matches,
show them to the user and ask which one they mean rather than guessing.

**Add a job**: `POST /api/jobs`. `company` and `title` are required; everything else has
server-side defaults. See field reference below.

**Update a job**: `PATCH /api/jobs/<id>`. Partial update; only send the fields that
changed.

**Delete a job**: `DELETE /api/jobs/<id>`. Permanently removes it, so it's irreversible;
always confirm the company/title with the user before running it, the same way you'd
confirm before any other destructive action.

**Multiple changes at once**: just make several requests in sequence, since there's no
batch endpoint. That's fine here since, unlike a username/password login flow, token auth
doesn't consume a rate-limited login attempt per call.

## Field reference

| Field | Notes |
|---|---|
| `company`, `title` | required on add, max 200 chars |
| `location` | free text, max 200 chars |
| `location_type` | one of `remote`, `hybrid`, `onsite`; default `remote` |
| `fit` | one of `strong`, `good`, `stretch`; default `good` |
| `fit_label` | display label, conventionally `Strong`/`Good`/`Stretch` to match `fit`; max 50 chars |
| `stage` | pipeline progress: one of `Not applied`, `Applied`, `Recruiter screen`, `Interview`, `Final round`; default `Not applied` |
| `outcome` | terminal result, independent of stage: `""` (none yet), `Offer`, `Rejected`, or `Withdrawn`; default `""` |
| `gap` | legacy free-text gap notes, max 2000 chars. The UI no longer has an input for this (superseded by `notes`), but existing values still display and the API still accepts updates to it |
| `applied_date` | `YYYY-MM-DD`, optional |
| `resume_file` / `cover_letter_file` | display name of the associated resume/cover letter, max 255 chars each. Settable directly via JSON for convenience, but real file bytes only get attached through the upload endpoint below. The UI's file picker uploads real files; this API text field alone won't put a document behind the download link |
| `job_url` | link to the job posting, max 1000 chars. Must start with `http://` or `https://` (rejected otherwise, since it's rendered as a link, so this is an XSS guard, not a formality) |
| `has_referral` / `recruiter_contact` | booleans, default `false` |
| `notes` | interview notes/contacts/follow-ups, max 10000 chars |

`fit`, `location_type`, `stage`, and `outcome` are validated server-side on both add and
update. An invalid value returns a 400 with an error message, so surface that message to
the user rather than silently retrying with something else. `stage` and `outcome` are
independent: e.g. a job rejected after the interview stage is
`stage: "Interview", outcome: "Rejected"`. Don't clear or guess at one when only updating
the other.

### Attaching an actual resume/cover-letter file

The `add`/`update` actions above only set metadata (the JSON `resume_file`/`cover_letter_file`
fields). To attach real file bytes so the dashboard's download link actually serves a
document, the user can use the UI's file picker, or you can upload one yourself:

```bash
curl -s -X POST "$JOB_TRACKER_URL/api/jobs/<id>/files/resume" \
  -H "Authorization: Bearer $JOB_TRACKER_TOKEN" \
  -F "file=@/path/to/resume.pdf"
```

(`resume` or `cover-letter` in the URL; PDF/DOC/DOCX only, 10MB max.) Only do this when the
user hands you a specific local file to attach; it's not something to do unprompted.

## Examples

**"Add a job at Airbnb, Sr Manager Analytics, strong fit, remote"**
```bash
curl -s -X POST "$JOB_TRACKER_URL/api/jobs" \
  -H "Authorization: Bearer $JOB_TRACKER_TOKEN" -H "Content-Type: application/json" \
  -d '{"company":"Airbnb","title":"Sr Manager Analytics","fit":"strong","fit_label":"Strong","location_type":"remote"}'
```

**"Mark the Docker role as Interview"**
1. `GET /api/jobs`, find the one matching "Docker".
2. If exactly one match: `PATCH /api/jobs/<id>` with `{"stage":"Interview"}`.

**"Toast gave me an offer"**
1. Find the job matching "Toast".
2. `PATCH` with `{"outcome":"Offer"}`. Leave `stage` alone unless the user also tells you
   what stage it happened at.

**"What's my status on Toast?"**
Find the matching job, then summarize its `stage`/`outcome`/`fit`/`notes` in plain
language. Don't just dump the raw JSON back at them.

**"Remove the NVIDIA application, I withdrew"**
Find the match, confirm it with the user, then `DELETE /api/jobs/<id>`.
