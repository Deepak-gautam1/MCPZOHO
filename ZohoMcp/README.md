# peetsmcp — Zoho Creator MCP server

An [MCP](https://modelcontextprotocol.io) server that connects Claude to a **Zoho Creator**
application. Claude can discover the app's forms and reports, read and write records, and invoke
standalone **Deluge** functions that you have published as Custom APIs.

It speaks MCP over **stdio**, so it drops straight into Claude Desktop's `mcpServers` config. All
configuration is environment-variable driven — no credentials live in the source tree.

---

## Tools

| Tool | What it does |
| --- | --- |
| `zoho_creator_list_applications` | Lists every app on the account (link names + owner). Start here when the app link name is unknown. |
| `zoho_creator_list_forms` | Lists the forms in an app (display names → link names). |
| `zoho_creator_list_reports` | Lists the reports/views in an app (display names → link names). |
| `zoho_creator_list_fields` | Lists a form's fields — link name, type, mandatory, lookup. Call before writing records. |
| `zoho_creator_get_records` | Reads records from a report, with `criteria` filtering, field selection and paging. |
| `zoho_creator_add_record` | Creates a record by submitting a form. |
| `zoho_creator_update_record` | Updates named fields on one record, by record id. |
| `zoho_creator_delete_record` | Permanently deletes one record, by record id. |
| `zoho_creator_call_function` | Invokes a Deluge function published as a Custom API. |

Every tool takes an optional `appLinkName`; when omitted it falls back to `ZOHO_APP_LINK_NAME`.

### CRUD tools vs. the custom-function tool

The CRUD tools are for **plain data access** — look up rows, insert a row, change a field, remove a
row. `zoho_creator_call_function` is for **business logic that already lives in the Creator app**:
PDF and invoice generation, approval and notification workflows, batch or multi-step processing,
integrations with other systems.

Prefer the custom function whenever the app implements the operation. A raw record write goes
straight at the data and bypasses whatever validation and side effects the app's own logic would
have applied; calling the published function keeps that behaviour intact.

---

## Setup

### 1. Register a Self Client

Zoho Creator API access cannot use redirect-based OAuth from a local MCP server — there is no
browser callback to redirect to. **Self Client** is the correct grant type: it is an app-to-app
flow with no redirect URI.

1. Go to <https://api-console.zoho.com> and sign in with the Zoho account that owns the Creator app.
2. **ADD CLIENT** → **Self Client** → **CREATE**.
3. Copy the **Client ID** and **Client Secret** — these become `ZOHO_CLIENT_ID` and
   `ZOHO_CLIENT_SECRET`.

> Use the API console for **your data centre**. `api-console.zoho.com` issues US credentials;
> India/EU/AU/JP accounts have their own console hosts, and credentials are not portable between
> regions.

### 2. Generate a grant token

Still in the API console, open your Self Client and pick the **Generate Code** tab.

**Scope** — paste as a comma-separated list. A read-only setup needs only the first two:

```
ZohoCreator.report.READ,
ZohoCreator.meta.READ,
ZohoCreator.form.CREATE,
ZohoCreator.report.CREATE,
ZohoCreator.report.UPDATE,
ZohoCreator.report.DELETE,
ZohoCreator.custom.CREATE,
ZohoCreator.custom.READ
```

| Scope | Needed for |
| --- | --- |
| `ZohoCreator.meta.READ` | `list_applications`, `list_forms`, `list_reports`, `list_fields` |
| `ZohoCreator.report.READ` | `get_records` |
| `ZohoCreator.form.CREATE` | `add_record` |
| `ZohoCreator.report.UPDATE` | `update_record` |
| `ZohoCreator.report.DELETE` | `delete_record` |
| `ZohoCreator.custom.READ` / `.CREATE` | `call_function` (GET / POST respectively) |

Set **Time Duration** to 10 minutes, give it any description, choose the portal/org if prompted,
and click **CREATE**. Copy the grant code immediately — **it expires in minutes and is single-use.**

### 3. Exchange the grant token for a refresh token

Run this within the grant token's lifetime. Swap the domain for your data centre if you are not on
`.com`.

**Easiest — the bundled helper** (same on every shell, and it explains Zoho's error codes):

```bash
node get-refresh-token.mjs --code THE_GRANT_CODE --client-id YOUR_ID --client-secret YOUR_SECRET
```

**bash / macOS / Linux:**

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=THE_GRANT_CODE_YOU_JUST_COPIED"
```

**PowerShell** — note that `curl` there is an *alias for `Invoke-WebRequest`*, which does not
understand `-X` or `-d`, and `\` is not a line-continuation character. Use `Invoke-RestMethod`:

```powershell
Invoke-RestMethod -Method Post -Uri "https://accounts.zoho.com/oauth/v2/token" -Body @{
  grant_type    = "authorization_code"
  client_id     = "YOUR_CLIENT_ID"
  client_secret = "YOUR_CLIENT_SECRET"
  code          = "THE_GRANT_CODE_YOU_JUST_COPIED"
}
```

…or call the real curl binary explicitly as `curl.exe`, continuing lines with a backtick:

```powershell
curl.exe -X POST "https://accounts.zoho.com/oauth/v2/token" `
  -d "grant_type=authorization_code" `
  -d "client_id=YOUR_CLIENT_ID" `
  -d "client_secret=YOUR_CLIENT_SECRET" `
  -d "code=THE_GRANT_CODE_YOU_JUST_COPIED"
```

The response looks like:

```json
{
  "access_token": "1000.xxxx.xxxx",
  "refresh_token": "1000.yyyy.yyyy",
  "expires_in": 3600,
  "token_type": "Bearer"
}
```

Save **`refresh_token`** as `ZOHO_REFRESH_TOKEN`. The access token is disposable — this server
mints fresh ones itself. If the response is `{"error":"invalid_code"}` the grant token expired or
was already used; generate a new one and retry.

### 4. Find your account owner and app link name

The quickest way is to ask the API — once credentials are set, run `npm run doctor` and it
prints every app with its `link_name` and owner, ready to paste into your config.

Or read them out of the Creator app URL in your browser:

```
https://creator.zoho.com/appbuilder/{ACCOUNT_OWNER}/{APP_LINK_NAME}/...
                                     ^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^
                                     ZOHO_ACCOUNT_OWNER
                                                     ZOHO_APP_LINK_NAME
```

The published (non-builder) URL has the same two segments. `ACCOUNT_OWNER` is your Creator handle
or org name, not your email address.

Form, report, and field **link names** are likewise not the display names shown in the UI. Get form
and report link names from `zoho_creator_list_forms` / `zoho_creator_list_reports`; field link names
are in the Creator form builder under each field's properties.

### 5. Install

```bash
cd PEETSMCP
npm install
```

Requires Node.js 18 or newer.

### 6. Configure the environment

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

For **local development** the server reads `.env.local` then `.env` from the project directory
(via [`loadEnv.js`](loadEnv.js) — no dependency, no `dotenv` package). Real environment variables
always win over file values, so the `env` block in your Claude Desktop config takes priority and
a stray `.env.local` can never silently override production config.

Both `.env` and `.env.local` are gitignored. **Claude Desktop does not read them** — for that,
values must go in the config's `env` block below.

### Verify the connection

```bash
npm run doctor
```

This checks which keys are set (it never prints their values), refreshes an access token, lists
every application on the account with its link name, and — once `ZOHO_APP_LINK_NAME` is set — lists
that app's forms and reports. Run it before touching the Claude Desktop config; it isolates
credential and data-centre problems from MCP wiring problems.

---

## Claude Desktop configuration

Config file location:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "peetsmcp": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\PEETSMCP\\server.js"],
      "env": {
        "ZOHO_CLIENT_ID": "1000.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        "ZOHO_CLIENT_SECRET": "your_client_secret_here",
        "ZOHO_REFRESH_TOKEN": "1000.XXXXXXXXXXXXXXXX.XXXXXXXXXXXXXXXX",
        "ZOHO_ACCOUNT_OWNER": "your_account_owner_name",
        "ZOHO_APP_LINK_NAME": "your_app_link_name",
        "ZOHO_ACCOUNTS_DOMAIN": "https://accounts.zoho.com",
        "ZOHO_API_DOMAIN": "https://creator.zoho.com"
      }
    }
  }
}
```

On macOS/Linux the `args` path is a normal POSIX path:
`["/Users/you/Codes/PeetsMCP/PEETSMCP/server.js"]`. On Windows, either escape the backslashes as
above or use forward slashes. The path **must be absolute** — Claude Desktop does not launch the
server from your project directory.

Restart Claude Desktop after editing the config. The server logs to stderr, which Claude Desktop
captures in its MCP logs — check there if the tools do not appear.

---

## Exposing a Deluge function as a Custom API

`zoho_creator_call_function` can only reach functions that Creator has published as a Custom API.

1. In the Creator app builder, write your logic as a **standalone function** (Workflow → Functions),
   not as a form or report script. Give its parameters explicit types, and have it `return` a
   value — a Map or a JSON string is easiest for Claude to consume.
2. Open **Settings → Custom API** (in some versions: the function's **⋮ → Create Custom API**).
3. Add the function as a Custom API and note:
   - the **link name** it is published under → `apiLinkName`
   - the **HTTP method** (GET or POST) → `method`
   - the **parameter names** → keys of `params` (or of `body` for a JSON payload)
4. Set the authentication type to **OAuth** so the server's bearer token is accepted, and make sure
   the OAuth scope you granted in step 2 above covers the method you published.
5. Publish the API.

Then, from Claude:

> Call the `generate_invoice_pdf` function for order 4567.

which becomes:

```json
{
  "apiLinkName": "generate_invoice_pdf",
  "method": "POST",
  "params": { "orderId": "4567" }
}
```

> **Note on the endpoint path.** This server calls
> `{ZOHO_API_DOMAIN}/api/v2.1/{owner}/{app}/custom/{apiLinkName}`. Creator has historically also
> served custom APIs from other paths depending on how the function was published (for example a
> public-key style `/creator/custom/{owner}/{function}` endpoint). If a call returns 404 while the
> record tools work fine, compare the URL Creator shows on the Custom API's detail screen with the
> one above; pointing `ZOHO_API_DOMAIN` at the host Creator names there resolves most mismatches.

---

## Notes

**Token expiry and caching.** Zoho access tokens last about an hour. The server keeps one in memory
and refreshes it roughly 60 seconds before expiry, so a long Claude session never pauses on an
expired token. Concurrent tool calls share a single in-flight refresh rather than each firing their
own. A 401 from Zoho — a token revoked mid-session, say — drops the cache and retries once. Nothing
is written to disk: restarting the server simply mints a new access token from the refresh token.

Refresh tokens themselves do not expire on a timer, but they are revoked if you delete the Self
Client or revoke it in the console, and Zoho caps the number of live refresh tokens per client
(~20) — regenerating repeatedly will eventually evict the oldest.

**What the API cannot see.** Creator's REST API exposes *structure and data only* — never
logic. There is no endpoint for Deluge source, functions, workflows, validation rules, or scheduled
jobs; `/functions`, `/workflows`, `/customfunctions` and `/export` all return
`{"code":1000,"description":"Invalid API URL format."}`. `zoho_creator_call_function` *executes* a
published function but never sees its body. To review or document Deluge, export the app from the
Creator UI and read the source as ordinary files.

Field metadata is form-scoped: `/form/{form}/fields` works, `/report/{report}/fields` does not.
To learn the columns behind a report, inspect the form feeding it.

**Endpoint layout.** Everything is served from `{ZOHO_API_DOMAIN}/api/v2.1/{owner}/...`. The
applications list is owner-scoped (`/api/v2.1/{owner}/applications`); there is no
`/api/v2.1/meta/applications` on this host — it 404s with Zoho code 2930. Zoho also exposes an
account-wide `/creator/v2.1/meta/applications` on the unified host `https://www.zohoapis.com`, but
this client stays on a single host and scheme.

**Multi-app usage.** `ZOHO_APP_LINK_NAME` is only a default. Every tool accepts `appLinkName`, so
one server instance reaches any app under the same `ZOHO_ACCOUNT_OWNER` as long as the OAuth scopes
cover it. Leave `ZOHO_APP_LINK_NAME` unset to force each call to name its app explicitly. For apps
under a *different* account owner, run a second server entry with its own `env` block and a distinct
key in `mcpServers`.

**Rate limits.** Creator enforces per-account API credit limits by plan. Prefer `criteria` and
`fields` on `zoho_creator_get_records` over pulling whole reports and filtering afterwards; each
page is a separate API call.

**Deletion is permanent.** `zoho_creator_delete_record` has no undo. Read the record back with
`zoho_creator_get_records` and confirm the id before deleting.

---

## Local development

```bash
npm run doctor            # verify credentials and list apps/forms/reports
npm start                 # run the server on stdio (it will wait for a client)
npm run check             # syntax-check every source file
```

Running `npm start` in a terminal is expected to sit silently after printing its startup line to
stderr — it is waiting for an MCP client to speak to it over stdin.

## File layout

```
PEETSMCP/
├── server.js              MCP server: tool registration and stdio transport
├── zohoClient.js          OAuth refresh, token cache, Creator REST API v2.1 calls
├── loadEnv.js             Dependency-free .env.local/.env loader for local dev
├── doctor.mjs             Connection check: credentials, token, apps, forms, reports
├── get-refresh-token.mjs  One-shot grant-token -> refresh-token exchange
├── package.json
├── .env.example           Template for all environment variables
└── README.md
```
