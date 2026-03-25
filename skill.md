# kamAI — Headless Browser API

You have access to a headless browser API that can navigate to any URL, interact with page elements, and extract content. Use this when you need to:

- Browse websites that require JavaScript rendering
- Fill forms, click buttons, navigate through multi-page flows
- Search government portals, legacy ASPX sites, web archives
- Extract structured data from rendered pages

## Base URL

```
https://kamai.minai.work/api/v1
```

## Authentication

Include your API key in the `x-api-key` header:
```
x-api-key: <your-api-key>
```

## Endpoints

### POST /api/v1/browse

Browse a URL with optional actions.

**Request:**
```json
{
  "url": "https://example.com",
  "selector": "#main-content",
  "timeout": 15000,
  "actions": [
    { "action": "type", "selector": "#search", "text": "query" },
    { "action": "click", "selector": "#submit" },
    { "action": "wait", "selector": ".results", "timeout": 10000 }
  ]
}
```

**Parameters:**
- `url` (required) — the URL to navigate to
- `selector` (optional) — CSS selector to narrow text extraction
- `timeout` (optional) — navigation timeout in ms (default: 15000)
- `actions` (optional) — array of actions to perform on the page

**Response:**
```json
{
  "ok": true,
  "url": "https://example.com/results",
  "title": "Search Results",
  "text": "Page content as plain text...",
  "links": [
    { "text": "Link text", "href": "https://example.com/page" }
  ],
  "forms": [
    { "tag": "input", "type": "text", "name": "q", "selector": "#search" }
  ],
  "length": 1234,
  "actions_performed": ["typed \"query\" into #search", "clicked #submit"]
}
```

## Available Actions

| Action | Parameters | Description |
|--------|-----------|-------------|
| `type` | `selector`, `text` | Type text into an input field |
| `click` | `selector` | Click an element |
| `click_and_wait` | `selector` | Click and wait for page navigation |
| `submit` | `selector?` | Submit a form (defaults to first form) |
| `select` | `selector`, `value` | Select an option in a dropdown |
| `wait` | `selector`, `timeout?` | Wait for an element to appear |
| `wait_ms` | `ms` | Wait for N milliseconds (max 5000) |
| `evaluate` | `text` | Run JavaScript on the page |

## Sessions (Optional)

For multi-step workflows that need to persist cookies and state:

```
POST /api/v1/session              → { sessionId: "..." }
GET  /api/v1/session/:sessionId   → session status
DELETE /api/v1/session/:sessionId → destroy session
```

Pass `sessionId` in your browse request to reuse the same browser context:
```json
{
  "url": "https://example.com/step2",
  "sessionId": "abc-123"
}
```

## Tips for Best Results

1. **Check forms first** — browse a page without actions to see available form fields in the `forms` array, then construct your actions
2. **Use `click_and_wait`** for navigation — regular `click` won't wait for the page to load
3. **ASPX sites** — use `submit` action for ASP.NET postback forms
4. **Use `selector`** to narrow extraction — reduces noise from headers/footers
5. **Chain actions** — you can type, click, wait, and extract in a single request

## Error Handling

```json
{
  "ok": false,
  "error": "Navigation timeout: 15000ms exceeded"
}
```

Common errors:
- `Blocked URL pattern` — file://, data://, localhost URLs are blocked
- `Navigation timeout` — page took too long to load
- `type requires "selector" and "text"` — missing action parameters

## Rate Limits

- 60 requests per minute per IP
- Responses include `X-RateLimit-Remaining` header