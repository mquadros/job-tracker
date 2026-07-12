// Remote MCP server exposing the jobs API as tools, so any MCP-capable client (Claude
// Desktop, a claude.ai custom connector, another agent) can drive it without a local shell —
// unlike the job-tracker Skill (curl-based, needs a shell tool), this only needs an
// MCP-compatible client. Auth reuses the same personal API token as the REST API
// (see middleware/auth.js's hashApiToken / requireAuthOrToken) via a bearer header, checked
// here directly rather than through requireAuthOrToken since createMcpExpressApp() builds
// its own isolated Express app rather than reusing the main app's middleware stack.
//
// Getting an MCP client to actually reach this endpoint still requires the job-tracker
// instance to be network-reachable from wherever that client runs — for Claude Desktop or
// Claude Code on the same machine/LAN, http://localhost:3000/mcp works as-is; for claude.ai
// (cloud-hosted), the app needs a public HTTPS URL first (reverse proxy or tunnel). Building
// this server doesn't change that — it's a separate, necessary step.
const fs = require('fs');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpExpressApp } = require('@modelcontextprotocol/sdk/server/express.js');
const { z } = require('zod/v4');
const db = require('../db');
const { hashApiToken } = require('../middleware/auth');
const { validateJobFields, stmts, storedFilePath, VALID_LOC, VALID_FILE_TYPES } = require('./jobs');

const findUserByTokenHash = db.prepare('SELECT id, username, role FROM users WHERE api_token_hash = ?');

const STAGE_DESC = 'One of: Not applied, Applied, Recruiter screen, Interview, Final round';
const OUTCOME_DESC = 'One of: Offer, Rejected, Withdrawn, or "" for no outcome yet. Independent of stage — do not guess at or clear this when only stage was mentioned, and vice versa.';
const FIT_DESC = 'One of: strong, good, stretch';
const LOC_DESC = `One of: ${VALID_LOC.join(', ')}`;

const jobAddSchema = {
  company: z.string().describe('Company name (required)'),
  title: z.string().describe('Job title (required)'),
  location: z.string().optional().describe('Free-text location, e.g. "Boston, MA"'),
  location_type: z.string().optional().describe(`${LOC_DESC} — default remote`),
  fit: z.string().optional().describe(`${FIT_DESC} — default good`),
  fit_label: z.string().optional().describe('Display label matching fit, e.g. "Strong" — default "Good"'),
  stage: z.string().optional().describe(`${STAGE_DESC} — default "Not applied"`),
  outcome: z.string().optional().describe(OUTCOME_DESC),
  applied_date: z.string().optional().describe('YYYY-MM-DD, optional'),
  job_url: z.string().optional().describe('Link to the job posting; must start with http:// or https://'),
  has_referral: z.boolean().optional().describe('Whether the user had a referral for this role'),
  recruiter_contact: z.boolean().optional().describe('Whether a recruiter reached out about this role'),
  notes: z.string().optional().describe('Interview notes, contacts, follow-ups')
};

const jobUpdateSchema = {
  id: z.number().describe('Job id, from list_jobs or find_jobs'),
  company: z.string().optional(),
  title: z.string().optional(),
  location: z.string().optional(),
  location_type: z.string().optional().describe(LOC_DESC),
  fit: z.string().optional().describe(FIT_DESC),
  fit_label: z.string().optional(),
  stage: z.string().optional().describe(STAGE_DESC),
  outcome: z.string().optional().describe(OUTCOME_DESC),
  applied_date: z.string().optional().describe('YYYY-MM-DD'),
  job_url: z.string().optional(),
  has_referral: z.boolean().optional(),
  recruiter_contact: z.boolean().optional(),
  notes: z.string().optional()
};

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function buildServerForUser(userId) {
  const server = new McpServer({ name: 'job-tracker', version: '1.0.0' });

  server.registerTool(
    'list_jobs',
    { title: 'List jobs', description: 'List every tracked job application for this account.', inputSchema: {} },
    async () => textResult(stmts.listByUser.all(userId))
  );

  server.registerTool(
    'find_jobs',
    {
      title: 'Find jobs',
      description: 'Case-insensitive substring search over company + title. There is no separate search endpoint — use this instead of list_jobs whenever a specific company or role is named, rather than scanning the full list yourself.',
      inputSchema: { query: z.string().describe('Text to search for in company or title') }
    },
    async ({ query }) => {
      const jobs = stmts.listByUser.all(userId);
      const q = query.toLowerCase();
      return textResult(jobs.filter(j => `${j.company} ${j.title}`.toLowerCase().includes(q)));
    }
  );

  server.registerTool(
    'add_job',
    { title: 'Add job', description: 'Create a new tracked job application. company and title are required; everything else has server-side defaults.', inputSchema: jobAddSchema },
    async (input) => {
      const {
        company, title, location = '', location_type = 'remote', fit = 'good', fit_label = 'Good',
        applied_date = '', stage = 'Not applied', outcome = '', job_url = '',
        has_referral = false, recruiter_contact = false, notes = ''
      } = input;
      if (!company || !title) return errorResult('company and title are required');

      const fields = { company, title, location, location_type, fit, fit_label, applied_date, stage, outcome, job_url, notes };
      const err = validateJobFields(fields);
      if (err) return errorResult(err);

      const result = stmts.insert.run(
        userId, company, title, location, location_type, fit, fit_label, '', '', '',
        applied_date, stage, outcome, job_url, has_referral ? 1 : 0, recruiter_contact ? 1 : 0, notes
      );
      return textResult(stmts.getById.get(result.lastInsertRowid));
    }
  );

  server.registerTool(
    'update_job',
    {
      title: 'Update job',
      description: 'Partially update an existing job application — only send the fields that changed.',
      inputSchema: jobUpdateSchema
    },
    async ({ id, ...updates }) => {
      const job = stmts.getByIdForUser.get(id, userId);
      if (!job) return errorResult('Job not found');

      const fields = Object.keys(updates).filter(k => updates[k] !== undefined);
      if (!fields.length) return errorResult('No fields to update');

      const err = validateJobFields(updates);
      if (err) return errorResult(err);

      const boolFields = ['has_referral', 'recruiter_contact'];
      const setClause = fields.map(f => `${f} = ?`).join(', ');
      const values = fields.map(f => (boolFields.includes(f) ? (updates[f] ? 1 : 0) : updates[f]));
      db.prepare(`UPDATE jobs SET ${setClause}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(...values, id, userId);

      return textResult(stmts.getById.get(id));
    }
  );

  server.registerTool(
    'delete_job',
    {
      title: 'Delete job',
      description: 'Permanently remove a job application. Irreversible — confirm the company/title with the user before calling this.',
      inputSchema: { id: z.number().describe('Job id, from list_jobs or find_jobs') }
    },
    async ({ id }) => {
      const job = stmts.getIdForUser.get(id, userId);
      if (!job) return errorResult('Job not found');
      stmts.deleteById.run(id);
      for (const type of VALID_FILE_TYPES) {
        fs.rmSync(storedFilePath(userId, id, type), { force: true });
      }
      return textResult({ ok: true });
    }
  );

  return server;
}

function requireApiTokenForMcp(req, res, next) {
  const authHeader = req.headers.authorization;
  const bearer = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!bearer) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing bearer token' }, id: null });
    return;
  }
  const user = findUserByTokenHash.get(hashApiToken(bearer));
  if (!user) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid API token' }, id: null });
    return;
  }
  req.jobTrackerUser = user;
  next();
}

function createMcpApp() {
  // createMcpExpressApp() defaults to host '127.0.0.1', which auto-attaches DNS-rebinding
  // Host-header validation that rejects anything but localhost/127.0.0.1/::1 — wrong for a
  // self-hosted app meant to be reached over the LAN (or later, a public hostname behind a
  // reverse proxy). The bearer-token check in requireApiTokenForMcp is the real auth boundary
  // here, so skip that middleware by passing a non-localhost host value.
  const mcpApp = createMcpExpressApp({ host: '0.0.0.0' });

  // Stateless: a fresh server + transport per request, no session store needed. Fine for a
  // personal-scale tool — trades away SSE-based multi-turn session resumption for
  // simplicity, which nothing here currently needs.
  mcpApp.post('/mcp', requireApiTokenForMcp, async (req, res) => {
    const server = buildServerForUser(req.jobTrackerUser.id);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error('[mcp] request error:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  return mcpApp;
}

module.exports = { createMcpApp };
