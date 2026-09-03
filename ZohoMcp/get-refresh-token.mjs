#!/usr/bin/env node
/**
 * get-refresh-token.mjs
 *
 * One-shot helper: exchange a Zoho Self Client grant token for a refresh token.
 * Avoids shell-quoting differences between bash, PowerShell and cmd.
 *
 * Usage:
 *   node get-refresh-token.mjs --code <grant> --client-id <id> --client-secret <secret>
 *   node get-refresh-token.mjs --code <grant>          # id/secret from env
 *
 * Options:
 *   --code           Grant token from the API console (single-use, expires in minutes)
 *   --client-id      Defaults to $ZOHO_CLIENT_ID
 *   --client-secret  Defaults to $ZOHO_CLIENT_SECRET
 *   --domain         Accounts domain, defaults to $ZOHO_ACCOUNTS_DOMAIN or
 *                    https://accounts.zoho.com
 *
 * Reminder: the grant token is single-use. If the exchange fails, generate a
 * fresh one in the console before retrying - the old one is spent either way.
 */

const KNOWN_FLAGS = new Set(["code", "client-id", "client-secret", "domain", "help"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const eq = token.indexOf("=");
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (!KNOWN_FLAGS.has(key)) {
      throw new Error(`Unknown option --${key}. Run with --help to see valid options.`);
    }
    args[key] = eq === -1 ? (argv[++i] ?? "") : token.slice(eq + 1);
  }
  return args;
}

const USAGE = `
Exchange a Zoho Self Client grant token for a refresh token.

  node get-refresh-token.mjs --code <grant> [--client-id <id>] [--client-secret <secret>]

  --code           Grant token from https://api-console.zoho.com (required)
  --client-id      Defaults to $ZOHO_CLIENT_ID
  --client-secret  Defaults to $ZOHO_CLIENT_SECRET
  --domain         Defaults to $ZOHO_ACCOUNTS_DOMAIN or https://accounts.zoho.com
                   Must match the data centre that issued the credentials:
                   .com (US) .in (India) .eu (Europe) .com.au (Australia)
                   .jp (Japan) zohocloud.ca (Canada) .sa (Saudi Arabia)
`.trim();

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if ("help" in args) {
    console.log(USAGE);
    return;
  }

  const code = (args.code ?? "").trim();
  const clientId = (args["client-id"] ?? process.env.ZOHO_CLIENT_ID ?? "").trim();
  const clientSecret = (args["client-secret"] ?? process.env.ZOHO_CLIENT_SECRET ?? "").trim();
  const domain = (args.domain ?? process.env.ZOHO_ACCOUNTS_DOMAIN ?? "https://accounts.zoho.com")
    .trim()
    .replace(/\/+$/, "");

  const missing = [];
  if (!code) missing.push("--code");
  if (!clientId) missing.push("--client-id (or $ZOHO_CLIENT_ID)");
  if (!clientSecret) missing.push("--client-secret (or $ZOHO_CLIENT_SECRET)");
  if (missing.length) {
    console.error(`Missing required value(s): ${missing.join(", ")}\n\n${USAGE}`);
    process.exit(2);
  }

  const tokenUrl = `${domain}/oauth/v2/token`;
  console.error(`Exchanging grant token at ${tokenUrl} ...`);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }).toString(),
  });

  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error(`Zoho returned a non-JSON response (HTTP ${response.status}):\n${raw}`);
    process.exit(1);
  }

  // Zoho reports OAuth failures with HTTP 200 plus an "error" field.
  if (payload.error) {
    console.error(`\nExchange failed: ${payload.error}\n`);
    const hints = {
      invalid_code:
        "The grant token expired (they last ~10 minutes) or was already used.\n" +
        "Generate a fresh one: api-console.zoho.com -> your Self Client -> Generate Code.",
      invalid_client:
        "Client id/secret rejected. Most often this is a data-centre mismatch: credentials\n" +
        "issued in one region are not valid in another. Re-run with --domain set to your\n" +
        "region, e.g. --domain https://accounts.zoho.eu",
      invalid_client_secret:
        "The client secret does not match the client id. Re-copy both from the console.",
    };
    if (hints[payload.error]) console.error(hints[payload.error] + "\n");
    process.exit(1);
  }

  if (!payload.refresh_token) {
    console.error(
      "\nZoho accepted the request but returned no refresh_token.\n" +
        "This happens when the grant token was already exchanged once - Zoho issues the\n" +
        "refresh token only on the first exchange. Generate a fresh grant code.\n\n" +
        `Response: ${JSON.stringify(payload, null, 2)}\n`
    );
    process.exit(1);
  }

  console.log("\nSuccess. Add this to the env block of your Claude Desktop config:\n");
  console.log(`  "ZOHO_REFRESH_TOKEN": "${payload.refresh_token}"\n`);
  console.log(
    `Access token granted alongside it expires in ${payload.expires_in ?? "?"}s - ignore it, ` +
      "the server mints its own.\n"
  );
  console.error("Store the refresh token like a password. Do not commit it.");
}

main().catch((err) => {
  console.error(`\nUnexpected error: ${err.message}`);
  process.exit(1);
});
