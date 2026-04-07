# kamai — Headless Browser API

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

Identify yourself with **either** header (not both):

```
x-wallet-address: 0xYourCeloWalletAddress
```

or, if your organization has generated an API key:

```
x-api-key: kam_yourKeyHere
```

API keys are **optional**. A wallet address works on its own. Keys are useful when multiple agents share one credit balance — generate one via `POST /api/v1/account/generate-key` with your wallet address.

## Credits & Pricing

| Request type | Cost |
|-------------|------|
| Page load (no actions) | $0.009 |
| Page load with actions | $0.013 |
| Brochure PDF generation | $0.050 |

- **First request each day is free** (per account)
- **Minimum deposit:** $0.10 USDC on Celo
- **Sister apps** (minai, registered partners): 50% off

To add credits, send USDC on Celo to the kamai wallet, then:
```
POST /api/v1/deposit
{ "txHash": "0x..." }
```

Check your balance:
```
GET /api/v1/deposit/balance
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
    { "action": "click_and_wait", "selector": "#submit" },
    { "action": "wait", "selector": ".results", "timeout": 10000 }
  ]
}
```

**Parameters:**
- `url` (required) — the URL to navigate to
- `selector` (optional) — CSS selector to narrow text extraction
- `timeout` (optional) — navigation timeout in ms (default: 15000, max: 30000)
- `actions` (optional) — array of actions to perform on the page (max 20)

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

**Response headers:**
- `X-Request-Cost` — the USD cost charged for this request
- `X-RateLimit-Remaining` — requests remaining in the current window

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
| `scroll_to` | `selector` | Scroll an element into view (centered) |
| `js_click` | `selector` | Force-click via JavaScript — bypasses overlays, viewport issues, and pointer interception. Use when regular `click` fails. |
| `set_date` | `selector`, `value` | Set a date on any date picker (native or custom). Value must be `yyyy-mm-dd`. Automatically handles native inputs, Wix/React/MUI calendar popups, and falls back to JS injection. |
| `evaluate` | `text` | Run JavaScript on the page |

## Sessions (Automatic)

**Sessions are automatic.** kamai maintains a persistent browser context per caller — cookies, auth state, and localStorage persist across requests without any extra work from the agent. Your identity (wallet address, API key, or IP) is used to match you to your session.

This means:
- **Login once**, then subsequent requests to the same site stay logged in
- No need to pass credentials on every request
- Sessions expire after **30 minutes** of inactivity

If you need to explicitly manage sessions (e.g. run multiple independent browser contexts), you can still use the session API:

```
POST /api/v1/session              → { sessionId: "..." }
GET  /api/v1/session/:sessionId   → session status
DELETE /api/v1/session/:sessionId → destroy session
```

Pass `sessionId` in your browse request to use a specific session:
```json
{
  "url": "https://example.com/step2",
  "sessionId": "abc-123"
}
```

## Account Management

```
GET  /api/v1/account               → account info, balance, API key
POST /api/v1/account/generate-key  → generate/regenerate an API key (requires x-wallet-address)
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
- `Insufficient credits` — deposit USDC to continue
- `type requires "selector" and "text"` — missing action parameters

---

## PDF Brochure Generation

Generate beautiful multi-page corporate PDFs from structured content. Supports iterative refinement — update an existing brochure without regenerating from scratch.

### Pricing

| Request type | Cost |
|-------------|------|
| Generate or update a brochure | $0.05 |
| Download a brochure | Free |

Sister apps (minai, registered partners) use this for free.

### GET /api/v1/brochure/templates

List available templates with their required and optional fields.

**Response:**
```json
{
  "ok": true,
  "templates": [
    {
      "id": "corporate-overview",
      "name": "Corporate Overview",
      "description": "Cover page + content sections + contact back page",
      "requiredFields": ["title", "sections"],
      "optionalFields": ["subtitle", "brandColor", "coverImage", "logo", "contactInfo", "footer", "charts"]
    }
  ]
}
```

### POST /api/v1/brochure/generate

Create a new brochure PDF.

**Request:**
```json
{
  "template": "corporate-overview",
  "content": {
    "title": "Acme Corp — Company Overview",
    "subtitle": "Innovation Since 1999",
    "brandColor": "#1a3b5c",
    "coverImage": "https://example.com/hero.jpg",
    "logo": "https://example.com/logo.png",
    "sections": [
      {
        "heading": "Our Mission",
        "body": "We build things that matter...",
        "image": "https://example.com/team.jpg",
        "imageCaption": "The Acme team at HQ"
      },
      {
        "heading": "Key Metrics",
        "body": "Our growth over the past year..."
      }
    ],
    "charts": [
      {
        "type": "bar",
        "title": "Revenue by Quarter",
        "labels": ["Q1", "Q2", "Q3", "Q4"],
        "values": [120, 180, 210, 350]
      }
    ],
    "contactInfo": {
      "companyName": "Acme Corp",
      "email": "info@acme.com",
      "phone": "+1-555-0100",
      "website": "https://acme.com",
      "address": "123 Innovation Ave, San Francisco, CA"
    },
    "footer": "© 2026 Acme Corp. All rights reserved."
  },
  "options": {
    "pageSize": "A4",
    "expiresIn": "30d"
  }
}
```

**Content fields:**

| Field | Type | Description |
|-------|------|-------------|
| `title` | string (required) | Main title / company name |
| `subtitle` | string | Tagline or subtitle |
| `brandColor` | string | Hex color (default `#1a3b5c`) |
| `accentColor` | string | Secondary hex color (auto-derived if omitted) |
| `coverImage` | string | URL or base64 data URI for cover background |
| `logo` | string | URL or base64 for company logo |
| `sections` | array | Content sections (corporate-overview template) |
| `sections[].heading` | string | Section heading |
| `sections[].body` | string | Section body text |
| `sections[].image` | string | URL or base64 for section image |
| `sections[].imageCaption` | string | Caption below the image |
| `products` | array | Product items (product-showcase template) |
| `products[].name` | string | Product name |
| `products[].description` | string | Product description |
| `products[].image` | string | Product image URL or base64 |
| `products[].price` | string | Display price (e.g. "$99.99") |
| `products[].specs` | object | Key-value spec pairs |
| `event` | object | Event details (event-invitation template) |
| `event.name` | string | Event name |
| `event.date` | string | Event date |
| `event.time` | string | Event time |
| `event.location` | string | Venue |
| `event.description` | string | Event description |
| `event.speakers` | array | Speaker bios with name, title, image, bio |
| `event.rsvpUrl` | string | Registration URL |
| `event.rsvpEmail` | string | RSVP email address |
| `charts` | array | Bar charts to embed in the brochure |
| `charts[].type` | string | `"bar"` (more types coming) |
| `charts[].title` | string | Chart title |
| `charts[].labels` | string[] | Category labels |
| `charts[].values` | number[] | Data values |
| `charts[].colors` | string[] | Custom bar colors (optional) |
| `contactInfo` | object | Contact details for back page |
| `footer` | string | Footer text on content pages |

**Options:**

| Option | Values | Default |
|--------|--------|---------|
| `pageSize` | `"A4"`, `"LETTER"` | `"A4"` |
| `expiresIn` | `"7d"`, `"14d"`, `"30d"` | `"30d"` |

**Response:**
```json
{
  "ok": true,
  "brochureId": "a1b2c3d4-...",
  "downloadUrl": "/api/v1/brochure/a1b2c3d4-.../download",
  "pageCount": 4,
  "sizeBytes": 245000,
  "expiresAt": "2026-05-07T12:00:00.000Z",
  "template": "corporate-overview"
}
```

### PATCH /api/v1/brochure/:id

Update an existing brochure. Send only the fields you want to change — they are merged into the original content and re-rendered.

**Request:**
```json
{
  "content": {
    "subtitle": "Updated Tagline",
    "sections": [
      { "heading": "Our NEW Mission", "body": "Updated copy..." },
      { "heading": "Key Metrics", "body": "Even better numbers..." }
    ]
  }
}
```

**Response:** Same shape as generate.

> **Note:** Arrays (`sections`, `products`, `charts`) are replaced entirely, not merged element-by-element. Send the full array with your changes.

### GET /api/v1/brochure/:id/download

Download the generated PDF. No authentication or credit charge required.

Returns `Content-Type: application/pdf`.

### Templates

| ID | Best for | Required fields |
|----|----------|----------------|
| `corporate-overview` | Company decks, proposals, annual summaries | `title`, `sections` |
| `product-showcase` | Product catalogs, menus, portfolios | `title`, `products` |
| `event-invitation` | Conferences, workshops, launches | `title`, `event` |

## Rate Limits

- 60 requests per minute per IP
- Responses include `X-RateLimit-Remaining` header
- Demo requests from the landing page are throttled to 1 per 3 seconds
