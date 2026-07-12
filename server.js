require('./db'); // init db + seed admin

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/jobs', require('./routes/jobs'));
app.use(require('./routes/mcp').createMcpApp()); // POST /mcp — remote MCP server, see routes/mcp.js

// Protocol-discovery paths (e.g. OAuth resource metadata that MCP clients like mcp-remote
// probe before connecting to /mcp) must 404 properly rather than fall through to the SPA
// catch-all below — a 200 HTML response there breaks any client expecting real 404/JSON,
// which is exactly what broke mcp-remote's pre-connection discovery request.
app.get('/.well-known/*', (req, res) => res.status(404).json({ error: 'Not found' }));

// SPA fallback (GET only — anything else unmatched falls to the JSON 404 below)
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Catches any remaining unmatched request (any method other than GET, any path) — e.g. a
// POST /register from an MCP client's OAuth dynamic-client-registration probe, which this
// app has no route for since it only supports static bearer tokens, not OAuth. Without this,
// Express's own default handler renders an HTML "Cannot POST /register" page, which is just
// as much an "expected JSON, got HTML" trap for API clients as the SPA catch-all was.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[server] Job tracker running on port ${PORT}`));
