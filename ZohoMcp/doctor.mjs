#!/usr/bin/env node
/**
 * doctor.mjs
 *
 * Connection check for the Zoho Creator MCP server. Run it after configuring
 * credentials and before wiring the server into Claude Desktop.
 *
 *   node doctor.mjs
 *
 * It reports which config keys are set (never their values), refreshes the
 * access token, and lists the Creator applications the account can reach -
 * which is where the link_name for ZOHO_APP_LINK_NAME comes from.
 */

import { loadEnvFiles } from "./loadEnv.js";
import { getAccessToken, listApplications, listForms, listReports } from "./zohoClient.js";

const { loadedFrom, keys } = loadEnvFiles();

const isSet = (name) => Boolean(process.env[name] && process.env[name].trim());
const masked = (name) =>
  isSet(name) ? `set (${process.env[name].trim().length} chars)` : "NOT SET";
const plain = (name, fallback) =>
  process.env[name]?.trim() || (fallback ? `${fallback}  (default)` : "NOT SET");

console.log("=== config ===");
console.log("env file(s) read      :", loadedFrom.length ? loadedFrom.join(", ") : "(none found)");
if (keys.length) console.log("keys defined in file  :", keys.join(", "));
console.log("ZOHO_CLIENT_ID        :", masked("ZOHO_CLIENT_ID"));
console.log("ZOHO_CLIENT_SECRET    :", masked("ZOHO_CLIENT_SECRET"));
console.log("ZOHO_REFRESH_TOKEN    :", masked("ZOHO_REFRESH_TOKEN"));
console.log("ZOHO_ACCOUNT_OWNER    :", plain("ZOHO_ACCOUNT_OWNER"));
console.log("ZOHO_APP_LINK_NAME    :", plain("ZOHO_APP_LINK_NAME"));
console.log("ZOHO_ACCOUNTS_DOMAIN  :", plain("ZOHO_ACCOUNTS_DOMAIN", "https://accounts.zoho.com"));
console.log("ZOHO_API_DOMAIN       :", plain("ZOHO_API_DOMAIN", "https://creator.zoho.com"));

const missing = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"].filter(
  (n) => !isSet(n)
);
if (missing.length) {
  console.error(`\nFAIL: missing required credential(s): ${missing.join(", ")}`);
  console.error("Set them in .env.local (local dev) or the Claude Desktop env block.");
  process.exit(1);
}

console.log("\n=== token refresh ===");
try {
  const token = await getAccessToken();
  console.log(`OK - access token acquired (${token.length} chars), cached in memory.`);
} catch (err) {
  console.error("FAIL -", err.message);
  console.error(
    "\nMost common causes:\n" +
      "  invalid_client  data-centre mismatch - set ZOHO_ACCOUNTS_DOMAIN and ZOHO_API_DOMAIN\n" +
      "                  to the region that issued the credentials (.com/.in/.eu/.com.au/.jp/.sa)\n" +
      "  invalid_code    the refresh token is wrong, revoked, or truncated on paste"
  );
  process.exit(1);
}

console.log("\n=== applications (GET /api/v2.1/{owner}/applications) ===");
let apps;
try {
  const response = await listApplications();
  apps = response?.applications ?? response?.data ?? response;

  if (Array.isArray(apps)) {
    console.log(`OK - ${apps.length} application(s) visible:\n`);
    for (const app of apps) {
      const link = app.link_name ?? app.linkName ?? "?";
      const owner = app.workspace_name ?? app.owner_name ?? app.account_owner_name ?? "?";
      console.log(`  ${app.application_name ?? app.display_name ?? link}`);
      console.log(`    ZOHO_APP_LINK_NAME = ${link}`);
      console.log(`    ZOHO_ACCOUNT_OWNER = ${owner}`);
      console.log("");
    }
  } else {
    console.log("OK - unexpected response shape, raw output:\n");
    console.log(JSON.stringify(response, null, 2).slice(0, 4000));
  }
} catch (err) {
  console.error("FAIL -", err.message);
  console.error(
    "\nIf token refresh succeeded but this 404s, ZOHO_API_DOMAIN is likely wrong for your\n" +
      "region, or your account is served from the unified host (https://www.zohoapis.com)."
  );
  process.exit(1);
}

// Only meaningful once an app is selected.
const appLink = process.env.ZOHO_APP_LINK_NAME?.trim();
if (!appLink) {
  console.log(
    "ZOHO_APP_LINK_NAME is not set - copy one of the link names above into your config\n" +
      "to make it the default, then re-run this check."
  );
  process.exit(0);
}

console.log(`=== forms and reports in "${appLink}" ===`);
for (const [label, fn, key] of [
  ["forms", listForms, "forms"],
  ["reports", listReports, "reports"],
]) {
  try {
    const response = await fn({});
    const items = response?.[key] ?? response?.data ?? response;
    if (Array.isArray(items)) {
      console.log(`\n${label} (${items.length}):`);
      for (const item of items) {
        console.log(`  ${item.link_name ?? "?"}  -  ${item.display_name ?? ""}`);
      }
    } else {
      console.log(`\n${label}: unexpected shape ${JSON.stringify(response).slice(0, 300)}`);
    }
  } catch (err) {
    console.log(`\n${label}: FAILED - ${err.message}`);
  }
}

console.log("\nDone.");
