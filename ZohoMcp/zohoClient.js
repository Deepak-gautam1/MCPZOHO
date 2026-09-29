/**
 * zohoClient.js
 *
 * Thin client for the Zoho Creator REST API (v2.1) with OAuth refresh-token
 * handling. All configuration is read from environment variables at call time
 * so the process can be started before the environment is fully populated.
 *
 * Required env vars:
 *   ZOHO_CLIENT_ID        - Self Client id from https://api-console.zoho.com
 *   ZOHO_CLIENT_SECRET    - Self Client secret
 *   ZOHO_REFRESH_TOKEN    - Refresh token obtained by exchanging a grant token
 *   ZOHO_ACCOUNT_OWNER    - Creator account owner name (from the app URL)
 *
 * Optional env vars:
 *   ZOHO_APP_LINK_NAME    - Default app link name when a call omits appLinkName
 *   ZOHO_ACCOUNTS_DOMAIN  - Default https://accounts.zoho.com  (data-centre specific)
 *   ZOHO_API_DOMAIN       - Default https://creator.zoho.com   (data-centre specific)
 *   ZOHO_CUSTOM_API_DOMAIN - Default https://www.zohoapis.com  (host that serves Custom APIs)
 */

import nodeFetch from "node-fetch";

// Node >= 18 ships a global fetch; node-fetch is the fallback for older runtimes.
const fetchFn = globalThis.fetch ?? nodeFetch;

/** Refresh this many ms before the token actually expires. */
const REFRESH_SKEW_MS = 60_000;

/** Zoho access tokens live ~1 hour; used when the response omits expires_in. */
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

const DEFAULT_ACCOUNTS_DOMAIN = "https://accounts.zoho.com";
const DEFAULT_API_DOMAIN = "https://creator.zoho.com";
// Custom APIs are not served under /api/v2.1 on creator.zoho.com; Zoho publishes them at
// https://www.zohoapis.com/creator/custom/{owner}/{apiLinkName} (scope ZohoCreator.customapi.EXECUTE).
const DEFAULT_CUSTOM_API_DOMAIN = "https://www.zohoapis.com";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function requireEnv(name, hint) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(
      `Missing required environment variable ${name}.` + (hint ? ` ${hint}` : "")
    );
  }
  return String(value).trim();
}

function accountsDomain() {
  return stripTrailingSlash(process.env.ZOHO_ACCOUNTS_DOMAIN || DEFAULT_ACCOUNTS_DOMAIN);
}

function apiDomain() {
  return stripTrailingSlash(process.env.ZOHO_API_DOMAIN || DEFAULT_API_DOMAIN);
}

function customApiDomain() {
  return stripTrailingSlash(process.env.ZOHO_CUSTOM_API_DOMAIN || DEFAULT_CUSTOM_API_DOMAIN);
}

/**
 * Resolve the Creator app link name: explicit argument wins, then the
 * ZOHO_APP_LINK_NAME default. Throws a clear error when neither is available.
 */
export function resolveAppLinkName(appLinkName) {
  const explicit = appLinkName && String(appLinkName).trim();
  if (explicit) return explicit;

  const fallback =
    process.env.ZOHO_APP_LINK_NAME && String(process.env.ZOHO_APP_LINK_NAME).trim();
  if (fallback) return fallback;

  throw new Error(
    "No Zoho Creator app link name available. Pass appLinkName with the request, " +
      "or set the ZOHO_APP_LINK_NAME environment variable as a default."
  );
}

/** Base path for every Creator v2.1 call: /api/v2.1/{owner}/{appLinkName} */
function creatorBasePath(appLinkName) {
  const owner = requireEnv(
    "ZOHO_ACCOUNT_OWNER",
    "It is the account-owner segment of your Creator app URL."
  );
  const app = resolveAppLinkName(appLinkName);
  return `/api/v2.1/${encodeURIComponent(owner)}/${encodeURIComponent(app)}`;
}

function requireArg(value, name) {
  const trimmed = value === undefined || value === null ? "" : String(value).trim();
  if (!trimmed) throw new Error(`${name} is required.`);
  return trimmed;
}

// ---------------------------------------------------------------------------
// OAuth: refresh-token flow with in-memory access-token caching
// ---------------------------------------------------------------------------

/** @type {{ accessToken: string | null, expiresAt: number }} */
let tokenCache = { accessToken: null, expiresAt: 0 };

/** De-duplicates concurrent refreshes so parallel tool calls issue one request. */
let refreshInFlight = null;

/** Drop the cached token (used after a 401 so the next call re-authenticates). */
export function invalidateAccessToken() {
  tokenCache = { accessToken: null, expiresAt: 0 };
}

async function requestNewAccessToken() {
  const params = new URLSearchParams({
    refresh_token: requireEnv(
      "ZOHO_REFRESH_TOKEN",
      "Generate it by exchanging a Self Client grant token (see README)."
    ),
    client_id: requireEnv(
      "ZOHO_CLIENT_ID",
      "Create a Self Client at https://api-console.zoho.com."
    ),
    client_secret: requireEnv("ZOHO_CLIENT_SECRET"),
    grant_type: "refresh_token",
  });

  const tokenUrl = `${accountsDomain()}/oauth/v2/token`;

  let response;
  try {
    response = await fetchFn(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });
  } catch (err) {
    throw new Error(`Could not reach the Zoho token endpoint (${tokenUrl}): ${err.message}`);
  }

  const rawBody = await response.text();
  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new Error(
      `Zoho token endpoint returned a non-JSON response (HTTP ${response.status}): ` +
        rawBody.slice(0, 500)
    );
  }

  // Zoho answers OAuth failures with HTTP 200 and an "error" field, so check both.
  if (!response.ok || payload.error) {
    const reason = payload.error || `HTTP ${response.status} ${response.statusText}`;
    throw new Error(
      `Zoho token refresh failed: ${reason}. ` +
        "Check ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN, and confirm " +
        "ZOHO_ACCOUNTS_DOMAIN matches the data centre the credentials were issued in."
    );
  }

  if (!payload.access_token) {
    throw new Error(`Zoho token refresh returned no access_token: ${rawBody.slice(0, 500)}`);
  }

  const ttlSeconds = Number(
    payload.expires_in_sec ?? payload.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS
  );
  // expires_in is sometimes delivered in milliseconds; normalise to seconds.
  const normalisedTtl = ttlSeconds > 100_000 ? ttlSeconds / 1000 : ttlSeconds;
  const lifetimeMs = Math.max(normalisedTtl * 1000 - REFRESH_SKEW_MS, 30_000);

  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + lifetimeMs,
  };

  return tokenCache.accessToken;
}

/**
 * Return a valid access token, refreshing proactively ~60s before expiry.
 */
export async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = requestNewAccessToken().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ---------------------------------------------------------------------------
// Generic request helper
// ---------------------------------------------------------------------------

/**
 * Perform an authenticated request against ZOHO_API_DOMAIN.
 *
 * @param {string} path        Absolute path, e.g. /api/v2.1/owner/app/forms
 * @param {object} [options]
 * @param {string} [options.method]  HTTP method (default GET)
 * @param {object} [options.query]   Query-string parameters (undefined/null skipped)
 * @param {unknown} [options.body]   JSON request body
 * @param {object} [options.headers] Extra headers
 * @param {boolean} [options.withHeaders] Resolve to { payload, headers } instead of payload
 * @param {string} [options.domain]  Host to call instead of ZOHO_API_DOMAIN
 * @returns {Promise<unknown>} Parsed JSON body (or raw text when not JSON)
 */
export async function zohoRequest(
  path,
  { method = "GET", query, body, headers, withHeaders = false, domain } = {}
) {
  const url = new URL(`${domain ?? apiDomain()}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  const send = async (accessToken) => {
    const init = {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        Accept: "application/json",
        ...headers,
      },
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return fetchFn(url.toString(), init);
  };

  let response;
  try {
    response = await send(await getAccessToken());
    // A revoked/expired token still in cache surfaces as 401 - retry once, fresh.
    if (response.status === 401) {
      invalidateAccessToken();
      response = await send(await getAccessToken());
    }
  } catch (err) {
    throw new Error(`Zoho request ${method} ${url.pathname} failed: ${err.message}`);
  }

  const rawBody = await response.text();
  let payload = null;
  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = rawBody;
    }
  }

  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(
      `Zoho API ${method} ${url.pathname} returned ${response.status} ${response.statusText}: ` +
        String(detail).slice(0, 1500)
    );
  }

  return withHeaders ? { payload, headers: response.headers } : payload;
}

// ---------------------------------------------------------------------------
// Creator API surface
// ---------------------------------------------------------------------------

/**
 * List every Creator application under the configured account owner.
 * GET /api/v2.1/{owner}/applications
 *
 * Needs ZOHO_ACCOUNT_OWNER but no app link name, so this is the call to make
 * when ZOHO_APP_LINK_NAME is still unknown - each entry's link_name is exactly
 * what the other functions expect as appLinkName.
 *
 * Note: the applications list is owner-scoped. There is no
 * /api/v2.1/meta/applications on this host - that path 404s with code 2930.
 * (The unified host https://www.zohoapis.com does serve an account-wide
 * /creator/v2.1/meta/applications, but we stay on ZOHO_API_DOMAIN so every
 * call in this client uses one host and one scheme.)
 */
export async function listApplications() {
  const owner = requireEnv(
    "ZOHO_ACCOUNT_OWNER",
    "It is the account-owner segment of your Creator app URL."
  );
  return zohoRequest(`/api/v2.1/${encodeURIComponent(owner)}/applications`);
}

/**
 * List the forms in a Creator application.
 * GET /api/v2.1/{owner}/{app}/forms
 */
export async function listForms({ appLinkName } = {}) {
  return zohoRequest(`${creatorBasePath(appLinkName)}/forms`);
}

/**
 * List the reports (views) in a Creator application.
 * GET /api/v2.1/{owner}/{app}/reports
 */
export async function listReports({ appLinkName } = {}) {
  return zohoRequest(`${creatorBasePath(appLinkName)}/reports`);
}

/**
 * List the fields defined on a form, with type, mandatory flag and lookup info.
 * GET /api/v2.1/{owner}/{app}/form/{formLinkName}/fields
 *
 * Fields are form-scoped: there is no report-level /fields endpoint (it 404s
 * with code 1000). To learn the columns behind a report, look up the form that
 * feeds it.
 *
 * The `type` in the response is Zoho's numeric field-type code, passed through
 * unchanged rather than guessed at - `is_lookup_field`, `max_char`, `unique`
 * and `mandatory` are the reliable signals.
 */
export async function listFields({ appLinkName, formLinkName } = {}) {
  const form = requireArg(formLinkName, "formLinkName");
  return zohoRequest(
    `${creatorBasePath(appLinkName)}/form/${encodeURIComponent(form)}/fields`
  );
}

/** Zoho rejects any other value for max_records with code 9250. */
export const ALLOWED_MAX_RECORDS = [200, 500, 1000];

/**
 * Fetch one page of records from a report.
 * GET /api/v2.1/{owner}/{app}/report/{reportLinkName}
 *
 * Pagination is cursor-based. The response carries a `record_cursor` header when
 * more rows remain; pass it back as `recordCursor` to get the next page. Offset
 * paging does NOT work: Creator accepts a `from` parameter, returns success, and
 * silently ignores it - you get page 1 again. Do not reintroduce it.
 *
 * @param {object}          opts
 * @param {string}          [opts.appLinkName]
 * @param {string}          opts.reportLinkName
 * @param {string}          [opts.criteria]     Deluge-style filter
 * @param {string[]|string} [opts.fields]       Field link names to return
 * @param {number}          [opts.maxRecords]   200 | 500 | 1000 (Zoho default 200)
 * @param {string}          [opts.recordCursor] Cursor from the previous page
 * @returns {Promise<object>} Zoho payload plus `record_cursor` (null when exhausted)
 */
export async function getRecords({
  appLinkName,
  reportLinkName,
  criteria,
  fields,
  maxRecords,
  recordCursor,
} = {}) {
  const report = requireArg(reportLinkName, "reportLinkName");

  const query = { criteria };

  if (Array.isArray(fields) && fields.length > 0) {
    query.field_config = "custom";
    query.fields = fields.join(",");
  } else if (typeof fields === "string" && fields.trim()) {
    query.field_config = "custom";
    query.fields = fields.trim();
  }

  if (maxRecords !== undefined && maxRecords !== null) {
    const limit = Number(maxRecords);
    if (!ALLOWED_MAX_RECORDS.includes(limit)) {
      throw new Error(
        `maxRecords must be one of ${ALLOWED_MAX_RECORDS.join(", ")} - Zoho rejects ` +
          `any other value (received ${maxRecords}).`
      );
    }
    query.max_records = limit;
  }

  const headers = {};
  if (recordCursor) headers.record_cursor = String(recordCursor);

  const { payload, headers: responseHeaders } = await zohoRequest(
    `${creatorBasePath(appLinkName)}/report/${encodeURIComponent(report)}`,
    { method: "GET", query, headers, withHeaders: true }
  );

  const nextCursor = responseHeaders.get("record_cursor");
  return {
    ...(payload && typeof payload === "object" ? payload : { data: payload }),
    record_cursor: nextCursor || null,
  };
}

/**
 * Page through a report and return every matching record.
 *
 * Guarded by maxPages because each page is a separate API call against a rate
 * limit (Zoho reports remaining quota in the x-rate-limit response header).
 * The result reports whether it stopped because the data ran out or the cap hit.
 *
 * @param {object} opts  As getRecords, plus:
 * @param {number} [opts.maxPages]  Page cap, default 50 (= 50k rows at 1000/page)
 * @returns {Promise<{records: object[], pages: number, complete: boolean}>}
 */
export async function getAllRecords({ maxPages = 50, ...opts } = {}) {
  const records = [];
  let cursor;
  let pages = 0;

  do {
    const page = await getRecords({ ...opts, maxRecords: opts.maxRecords ?? 1000, recordCursor: cursor });
    const rows = Array.isArray(page.data) ? page.data : [];
    records.push(...rows);
    cursor = page.record_cursor;
    pages += 1;
  } while (cursor && pages < maxPages);

  return { records, pages, complete: !cursor };
}

/**
 * Create a record through a form.
 * POST /api/v2.1/{owner}/{app}/form/{formLinkName}
 *
 * @param {object} opts
 * @param {string} [opts.appLinkName]
 * @param {string} opts.formLinkName
 * @param {object|object[]} opts.data  Field link name -> value (or an array of such objects)
 */
export async function addRecord({ appLinkName, formLinkName, data } = {}) {
  const form = requireArg(formLinkName, "formLinkName");
  if (!data || typeof data !== "object") {
    throw new Error("data is required and must be an object of fieldLinkName -> value.");
  }

  return zohoRequest(`${creatorBasePath(appLinkName)}/form/${encodeURIComponent(form)}`, {
    method: "POST",
    body: { data },
  });
}

/**
 * Update a single record by id.
 * PATCH /api/v2.1/{owner}/{app}/report/{reportLinkName}/{recordId}
 */
export async function updateRecord({ appLinkName, reportLinkName, recordId, data } = {}) {
  const report = requireArg(reportLinkName, "reportLinkName");
  const id = requireArg(recordId, "recordId");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("data is required and must be an object of fieldLinkName -> value.");
  }

  return zohoRequest(
    `${creatorBasePath(appLinkName)}/report/${encodeURIComponent(report)}/${encodeURIComponent(id)}`,
    { method: "PATCH", body: { data } }
  );
}

/**
 * Delete a single record by id.
 * DELETE /api/v2.1/{owner}/{app}/report/{reportLinkName}/{recordId}
 */
export async function deleteRecord({ appLinkName, reportLinkName, recordId } = {}) {
  const report = requireArg(reportLinkName, "reportLinkName");
  const id = requireArg(recordId, "recordId");

  return zohoRequest(
    `${creatorBasePath(appLinkName)}/report/${encodeURIComponent(report)}/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

/**
 * Invoke a standalone Deluge function published as a Custom API.
 * GET or POST {ZOHO_CUSTOM_API_DOMAIN}/creator/custom/{owner}/{apiLinkName}
 * Needs the OAuth scope ZohoCreator.customapi.EXECUTE on the refresh token.
 *
 * @param {object} opts
 * @param {string} [opts.appLinkName]   Unused: Custom APIs are account-level, not app-level
 * @param {string} opts.apiLinkName     Link name given to the Custom API
 * @param {"GET"|"POST"} [opts.method]  Must match the method the API was published with
 * @param {object} [opts.params]        Query-string arguments (usable by both methods)
 * @param {object} [opts.body]          JSON payload, POST only
 */
export async function callCustomFunction({
  appLinkName,
  apiLinkName,
  method = "POST",
  params,
  body,
} = {}) {
  const api = requireArg(apiLinkName, "apiLinkName");
  const httpMethod = String(method).toUpperCase();

  if (httpMethod !== "GET" && httpMethod !== "POST") {
    throw new Error(`callCustomFunction supports GET or POST, received "${method}".`);
  }
  if (httpMethod === "GET" && body !== undefined) {
    throw new Error("body cannot be sent with a GET custom-function call; use params instead.");
  }

  const owner = requireEnv(
    "ZOHO_ACCOUNT_OWNER",
    "It is the account-owner segment of your Creator app URL."
  );
  return zohoRequest(`/creator/custom/${encodeURIComponent(owner)}/${encodeURIComponent(api)}`, {
    method: httpMethod,
    query: params,
    body: httpMethod === "POST" ? (body ?? {}) : undefined,
    domain: customApiDomain(),
  });
}
