# Browse Service (kamai)

Headless browser service (Playwright + Chromium) with a self-improving domain memory layer. Runs on the kamai box (`45.76.180.229:3100`, public URL `https://kamai.minai.work`).

## Architecture

- **Playwright + Chromium** headless browser for rendering JS-heavy pages, ASPX sites, SPAs
- **SQLite** (`browse_memories.db`) stores per-domain learnings that improve over time
- **PM2** managed, auto-restarts on reboot
- **Firewall**: port 3100 restricted to sibling VPS IPs only; public access via nginx at port 443

## Tools

| Tool | Description |
|------|-------------|
| `browse_page` | Browse a URL with optional interactions (click, type, evaluate JS, etc.) |
| `web_search` | Brave web search — only available if `BRAVE_API_KEY` is set in env |

## Endpoints

### `POST /browse`

Legacy endpoint (used by minai API). Navigate to a URL, optionally interact with the page, extract content.

```json
{
  "url": "https://example.com",
  "actions": [
    { "action": "type", "selector": "#search", "text": "query" },
    { "action": "click_and_wait", "selector": "#submit" }
  ],
  "selector": ".results",
  "timeout": 15000
}
```

**Response:**
```json
{
  "ok": true,
  "url": "https://example.com/results",
  "title": "Search Results",
  "text": "...",
  "links": [{ "text": "Link", "href": "https://..." }],
  "forms": [{ "tag": "input", "type": "text", "selector": "#search", "placeholder": "Search..." }],
  "memories": ["Use /Indexes/index for keyword search instead of homepage"],
  "actions_performed": ["typed \"query\" into #search", "clicked #submit → navigated"],
  "length": 4500
}
```

**Available actions:**

| Action | Required params | Description |
|--------|----------------|-------------|
| `type` | `selector`, `text` | Clear field and type text |
| `click` | `selector` | Click element, 500ms pause |
| `click_and_wait` | `selector` | Click and wait for page navigation |
| `submit` | `selector?` | Programmatic form.submit() + wait for navigation |
| `evaluate` | `text` | Run arbitrary JS (pass code in `text`) |
| `select` | `selector`, `value` | Choose dropdown option |
| `wait` | `selector` | Wait for element to appear |
| `wait_ms` | `ms` | Pause (max 5000ms) |

**Limits:** max 20 actions per request, 30K char text cap, 15s default timeout.

**Safety:** blocks `file://`, `data://`, localhost, and private IP ranges.

---

### `POST /mcp` — MCP Server (Streamable HTTP transport)

Standard [Model Context Protocol](https://modelcontextprotocol.io) endpoint. Any MCP client (Claude Code, Claude Desktop, Ollama, LM Studio, etc.) can connect to `https://kamai.minai.work/mcp`.

Protocol version: `2025-03-26`. Supports `initialize`, `tools/list`, `tools/call`, `ping`.

**Example: initialize**
```json
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "myapp", "version": "1.0" } } }

// Response
{ "jsonrpc": "2.0", "id": 1, "result": {
    "protocolVersion": "2025-03-26",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "kamai", "version": "0.0.2" } } }
```

**Example: list tools**
```json
// Request
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }

// Response
{ "jsonrpc": "2.0", "id": 2, "result": { "tools": [ { "name": "browse_page", ... } ] } }
```

**Example: call a tool**
```json
// Request
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "browse_page", "arguments": { "url": "https://example.com" } } }

// Response
{ "jsonrpc": "2.0", "id": 3, "result": { "content": [{ "type": "text", "text": "Page: Example..." }] } }
```

**Claude Code config** (`~/.claude/claude_desktop_config.json` or project `.mcp.json`):
```json
{
  "mcpServers": {
    "kamai": {
      "type": "http",
      "url": "https://kamai.minai.work/mcp"
    }
  }
}
```

---

### `GET /openai/tools` — OpenAI function schema

Returns tool definitions in OpenAI function-calling format. Use this to inject tool schemas into any OpenAI-API-compatible LLM request.

```json
[
  {
    "type": "function",
    "function": {
      "name": "browse_page",
      "description": "Browse a URL using a headless Chromium browser...",
      "parameters": { "type": "object", "properties": { "url": { ... } }, "required": ["url"] }
    }
  }
]
```

**llama.cpp / Ollama usage:** fetch the schemas, include them in your chat request's `tools` array, then forward tool calls to `POST /openai/execute`.

### `POST /openai/execute` — Execute a tool call

Accepts an OpenAI-style tool call object and returns the result as plain text. `arguments` can be a JSON string (as the LLM outputs it) or a parsed object.

```json
// Request
{ "name": "browse_page", "arguments": "{\"url\": \"https://example.com\"}" }

// Response
{ "content": "Page: Example Domain\nURL: https://example.com\nLength: 648 chars\n\n..." }
```

---

### `GET /browse/memories?domain=example.com`

Retrieve all learnings for a domain. Omit `domain` to list all memories.

```json
{
  "ok": true,
  "domain": "philgeps.gov.ph",
  "memories": [
    {
      "id": 1,
      "domain": "philgeps.gov.ph",
      "learning": "Use /Indexes/index for keyword search instead of the homepage search form",
      "created_at": "2026-03-22 10:30:00"
    }
  ]
}
```

### `POST /browse/memories`

Save a new learning for a domain.

```json
{ "domain": "philgeps.gov.ph", "learning": "Use /Indexes/index for keyword search" }
```

**Response:** `{ "ok": true, "id": 1, "domain": "philgeps.gov.ph", "learning": "..." }`

### `DELETE /browse/memories/:id`

Delete a specific memory by ID.

### `GET /health`

```json
{ "ok": true, "engine": "playwright-chromium", "memories": 3, "tools": ["browse_page", "web_search"] }
```

---

## Domain Memories — How It Works

1. When `POST /browse` is called, the service extracts the domain from the URL
2. Any matching memories from `browse_page_memories` are included in the response as `memories[]`
3. The LLM sees these tips alongside the page content and can adjust its approach
4. When the LLM discovers a better navigation path, it calls `browse_page_memory` (via the minai API tool) to save the learning
5. Future requests to the same domain automatically benefit from the saved knowledge

**Design principle:** each tool on this server gets its own SQLite database and `*_memories` table. As new tools are added, they spawn their own memory stores following the same pattern.

## Integration (minai API)

The minai API exposes these tools to the LLM:

- **`browse_web`** — calls `POST /browse`, surfaces `memories` as "Domain tips" in the response
- **`browse_page_memory`** — calls `POST /browse/memories` to save a learning

## Deployment

```bash
# On the kamai box (45.76.180.229)
ssh browse
cd /opt/kamai
git pull origin main
npm install
pm2 restart kamai
```

To enable `web_search`, add `BRAVE_API_KEY=<key>` to `/opt/kamai/.env` before restarting.

## Files

- `server.js` — HTTP server, Playwright browser, SQLite memories, MCP + OpenAI endpoints
- `browse_memories.db` — SQLite database (auto-created on first run)
- `package.json` — dependencies: `playwright`, `better-sqlite3`
