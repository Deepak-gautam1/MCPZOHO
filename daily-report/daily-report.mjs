#!/usr/bin/env node
/**
 * daily-report.mjs
 *
 * Builds the Peet's Rewards daily health report, one Dubai day at a time, from
 * Zoho Creator exports. The report feeds the "Rewards Daily Health" dashboard.
 *
 * It never talks to Zoho itself; the ZohoMcp connector does the reading:
 *
 *   1. node daily-report.mjs plan [--date YYYY-MM-DD]
 *        Picks the days to build (yesterday, plus either of the two days before
 *        it that was never published, because Creator deletes API and NCR logs
 *        after 3 days) and prints the zoho_creator_get_all_records calls to
 *        make, each with a saveAs file name. The plan is also kept as plan.json.
 *   2. Make every call in the plan through the connector, arguments unchanged.
 *   3. node daily-report.mjs build
 *        Reads the saved files and writes summary-<date>.json and
 *        day-<date>.json for each planned day, then prints what it built.
 *   4. Publish both files to the dashboard's database, then run
 *        node daily-report.mjs mark --date YYYY-MM-DD   (once per published day)
 *
 *   node daily-report.mjs history --from YYYY-MM-DD --to YYYY-MM-DD --tx FILE
 *        [--signups FILE] [--stores FILE]
 *        Builds transaction-only reports for older days, once the logs are gone.
 *
 * Exports are read from the folder the connector's saveAs writes to (ZOHO_EXPORT_DIR,
 * default <system temp>/zoho-mcp-exports). Reports and the list of published days
 * go to %LOCALAPPDATA%\peets-daily-report (PEETS_REPORT_DIR, or --out). Every time
 * is Dubai time (UTC+4), the Creator app's time zone.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The connector and this script can run with different TEMP folders, so look in each.
const EXPORT_DIRS = [
  process.env.ZOHO_EXPORT_DIR,
  join(tmpdir(), "zoho-mcp-exports"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Temp", "zoho-mcp-exports"),
].filter(Boolean);
const EXPORT_DIR = EXPORT_DIRS[0];
// Reports and the published-days state live in one fixed per-user folder.
const REPORT_DIR = process.env.PEETS_REPORT_DIR ||
  join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "peets-daily-report");
// The company store master, extracted from the "Store Master Sheet" workbook by update-store-master.py,
// and corrections to it that the workbook doesn't carry yet (stores that have closed).
const MASTER_FILE = join(dirname(fileURLToPath(import.meta.url)), "store-master.json");
const OVERRIDES_FILE = join(dirname(fileURLToPath(import.meta.url)), "store-overrides.json");
// A restaurant is "quiet" against the median of its own last 14 days.
const BASELINE_DAYS = 14;
const DUBAI_OFFSET_MS = 4 * 3600_000;
const DAY_MS = 86_400_000;
const POINTS_PER_AED = 40;
// The dashboard's store caps a document at 256 KiB; stay well under it.
const DOC_BUDGET_BYTES = 230_000;
const LIST_CAP = 300;

const SALE_TYPES = new Set(["Purchase", "Redeem", "Purchase & Redeem"]);
const DAY_SOURCES = ["transactions", "pos", "appapi", "ncr", "tier", "orders", "carts", "signups", "backlog", "referrals30"];

const TX_FIELDS = [
  "Order_ID", "Transaction_Time", "Type_field", "Status", "Restaurant_Name.Store_ID", "Customer",
  "Customer.Phone_Number", "Total_Invoice_Amount", "Total_Discount_Amount", "Total_Purchase_Amount",
  "Earned_Loyalty_Points", "Burned_Points", "Bonus_Points_earned", "Bonus_Points_Burned",
  "Bonus_Expiration", "Bonus_Type", "BonusValidity", "Remaining_Bonus_Points",
];
const ORDER_FIELDS = [
  "Type_field", "Customer", "Cart_Status", "Payment_Status", "Sub_Total", "Payment_Coupon_Discount_s",
  "Points_Redeem_values", "Total_Amount_s", "Pos_orderid", "Pos_Message", "Method_of_Ordering",
  "Restaurant_Name_cart_order_all", "Order_Placed_On",
];
const SIGNUP_FIELDS = [
  "Name", "Phone_Number", "Email", "Date_Of_Birth", "Referral_Code",
  "Reference_Code_Other_Customer_Code", "Status", "Added_Time",
];

// Mobile app API types, from apiEndPoints.main. Unlisted numbers show as "type N".
const APP_API_LABELS = {
  1: "Home screen", 2: "Our craft page", 3: "Favourites", 5: "Welcome bonus screen",
  6: "Brand commitment screen", 7: "Store list", 9: "Log out", 10: "Contact us", 11: "About us",
  12: "Settings", 13: "Refer a friend", 14: "Rate the app", 15: "Privacy policy", 16: "Menu",
  17: "Product detail", 18: "Save cart", 19: "My orders", 20: "Points history", 21: "Add favourite",
  22: "Offers", 23: "Order items", 24: "Order detail", 25: "Profile", 26: "Coupons",
  27: "Delete-account page", 28: "Delete account", 30: "Order status", 31: "Curbside car details",
  33: "Place order", 34: "Rate order", 35: "Terms", 36: "Update profile",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_IDX = Object.fromEntries(MON.map((m, i) => [m, i]));
const pad = (n) => String(n).padStart(2, "0");

/** Zoho datetimes are Dubai wall-clock strings ("29-Sep-2026 13:04:32"); kept as naive UTC ms. */
function parseZ(s) {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(String(s || "").trim());
  if (!m || !(m[2] in MON_IDX)) return null;
  return Date.UTC(+m[3], MON_IDX[m[2]], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}
function fmtZ(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
const clock = (ms) => (ms === null ? "" : new Date(ms).toISOString().slice(11, 19));
const isoToMs = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const msToIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => msToIso(isoToMs(iso) + n * DAY_MS);
const dubaiToday = () => msToIso(Date.now() + DUBAI_OFFSET_MS);
const zDay = (iso) => fmtZ(isoToMs(iso));
const weekday = (iso) => new Date(isoToMs(iso)).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

function checkIso(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || msToIso(isoToMs(v)) !== v) {
    fail(`Expected a date as YYYY-MM-DD, got ${JSON.stringify(v)}.`);
  }
  return v;
}

const num = (v) => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const r2 = (x) => Math.round(x * 100) / 100;
const digits = (p) => String(p || "").replace(/\D/g, "");
const custId = (r) => (r.Customer && r.Customer.ID) || null;
const custName = (r) => String((r.Customer && (r.Customer.Name || r.Customer.zc_display_value)) || "").trim();
const lookupText = (v) => (v && typeof v === "object" ? String(v.zc_display_value || "").trim() : String(v || "").trim());

function maskPhone(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  return s.length <= 8 ? `${s.slice(0, 2)}•••` : `${s.slice(0, 6)}•••${s.slice(-4)}`;
}
/** Log messages quote customer emails; keep the domain only. */
const maskEmails = (s) => String(s || "").replace(/([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]*)/g, "$1…@$2");

function fail(message) {
  console.error(`daily-report: ${message}`);
  process.exit(1);
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

/** An export file is the connector's result: {count, pages, complete, records}. */
function loadSource(file) {
  if (!file || !existsSync(file)) return { available: false, count: 0, complete: false, records: [] };
  const data = readJson(file, null);
  if (!data || !Array.isArray(data.records)) fail(`${file} is not a get_all_records result.`);
  return { available: true, count: data.records.length, complete: data.complete !== false, records: data.records };
}
const unavailable = () => ({ available: false, count: 0, complete: false, records: [] });

function countBy(items, key) {
  const out = {};
  for (const it of items) { const k = typeof key === "function" ? key(it) : it[key]; out[k] = (out[k] || 0) + 1; }
  return out;
}

// ---------------------------------------------------------------------------
// Plan: which days, and which connector calls
// ---------------------------------------------------------------------------

function call(label, day, source, args) {
  return { label, day, source, args };
}

function callsForDay(D) {
  const F = zDay(D), T = zDay(addDays(D, 1)), W30 = zDay(addDays(D, -29));
  const inDay = (f) => `${f} >= "${F}" && ${f} < "${T}"`;
  const file = (s) => `peets-${D}-${s}.json`;
  return [
    call(`${D} transactions`, D, "transactions", {
      reportLinkName: "All_Transactions",
      criteria: `(${inDay("Transaction_Time")}) || (${inDay("Added_Time")})`,
      fields: TX_FIELDS, maxPages: 40, saveAs: file("transactions"),
    }),
    call(`${D} till calls`, D, "pos", {
      reportLinkName: "ApiLog_Report", criteria: `Api_Type == "0" && ${inDay("Added_Time")}`,
      fields: ["Request_Pay_load", "Modified_Time"], maxPages: 40, saveAs: file("pos"),
    }),
    call(`${D} app API calls`, D, "appapi", {
      reportLinkName: "ApiLog_Report", criteria: `Api_Type != "0" && ${inDay("Added_Time")}`,
      fields: ["Api_Type"], maxPages: 60, saveAs: file("appapi"),
    }),
    call(`${D} NCR logs`, D, "ncr", {
      reportLinkName: "All_Ncr_Logs", criteria: `Title != "Tier Validation Schedule" && ${inDay("Added_Time")}`,
      fields: ["Title", "error", "Added_Time"], maxPages: 20, saveAs: file("ncr"),
    }),
    call(`${D} tier job log`, D, "tier", {
      reportLinkName: "All_Ncr_Logs", criteria: `Title == "Tier Validation Schedule" && ${inDay("Added_Time")}`,
      fields: ["Added_Time"], maxPages: 1, saveAs: file("tier"),
    }),
    call(`${D} app orders`, D, "orders", {
      reportLinkName: "Cart_Order_Test_Report", criteria: inDay("Order_Placed_On"),
      fields: ORDER_FIELDS, maxPages: 5, saveAs: file("orders"),
    }),
    call(`${D} app carts`, D, "carts", {
      reportLinkName: "Cart_Order_Test_Report", criteria: `Type_field == "Cart" && ${inDay("Added_Time")}`,
      fields: ["Total_Amount_s"], maxPages: 5, saveAs: file("carts"),
    }),
    call(`${D} sign-ups`, D, "signups", {
      reportLinkName: "All_Customers", criteria: inDay("Added_Time"),
      fields: SIGNUP_FIELDS, maxPages: 5, saveAs: file("signups"),
    }),
    call(`${D} expiry backlog`, D, "backlog", {
      reportLinkName: "All_Transactions",
      criteria: `Type_field == "Bonus" && BonusValidity < "${T}" && Remaining_Bonus_Points > 0`,
      fields: ["Customer", "Remaining_Bonus_Points", "BonusValidity", "Bonus_Type"], maxPages: 10, saveAs: file("backlog"),
    }),
    call(`${D} referrals, last 30 days`, D, "referrals30", {
      reportLinkName: "All_Transactions",
      criteria: `Type_field == "Bonus" && Bonus_Type == "Referral" && Transaction_Time >= "${W30}" && Transaction_Time < "${T}"`,
      fields: ["Customer", "Transaction_Time", "Bonus_Points_earned"], maxPages: 5, saveAs: file("referrals30"),
    }),
  ];
}

function sharedCalls(runTag) {
  return [
    call("store list", null, "stores", {
      appLinkName: "peets-restaurant-management", reportLinkName: "All_Restaurant",
      fields: ["Store_ID", "Restaurant_Name", "Store_Name", "Restaurant_ID", "isActive"],
      maxPages: 2, saveAs: `peets-run${runTag}-stores.json`,
    }),
    call("all members", null, "members", {
      reportLinkName: "All_Customers", fields: ["Name", "Phone_Number", "Email", "Date_Of_Birth"],
      maxPages: 80, saveAs: `peets-run${runTag}-members.json`,
    }),
  ];
}

function outDir(opts) {
  const dir = resolve(typeof opts.out === "string" ? opts.out : REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The export file of that name, from --in or any of the export folders; null when absent. */
function findExport(name, preferred) {
  for (const dir of [preferred, ...EXPORT_DIRS].filter(Boolean)) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}
const loadState = (dir) => readJson(join(dir, "state.json"), { published: [] });

function cmdPlan(opts) {
  const dir = outDir(opts);
  const state = loadState(dir);
  let days;
  if (opts.date) {
    days = [].concat(opts.date).map(checkIso);
  } else {
    const y = addDays(dubaiToday(), -1);
    days = [addDays(y, -2), addDays(y, -1), y].filter((d) => !state.published.includes(d));
  }
  const runTag = new Date().toISOString().slice(0, 16).replace(/\D/g, "");
  const calls = days.length ? [...sharedCalls(runTag), ...days.flatMap(callsForDay)] : [];
  const plan = { createdAt: new Date().toISOString(), runTag, days, exportDir: EXPORT_DIR, calls };
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 1));
  console.log(JSON.stringify({
    days,
    note: days.length ? `${calls.length} connector calls` : "Nothing to build: those days are already published.",
    exportDir: EXPORT_DIR,
    calls: calls.map((c) => ({ label: c.label, args: c.args })),
  }, null, 1));
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** "Peet's Coffee - City Walk", "Peets Coffee, Furjan", "Peets Al Seef" -> the place name. */
const placeName = (s) => String(s || "").replace(/^Peet'?s\s+(Cof+ee\s*)?[-,]?\s*/i, "").trim();

function loadMaster() {
  const master = readJson(MASTER_FILE, null);
  if (!master || !Array.isArray(master.stores)) return null;
  const closed = (readJson(OVERRIDES_FILE, {}) || {}).closed || {};
  return { ...master, stores: master.stores.filter((s) => !(s.storeId in closed)), closed };
}

/** Zoho's store list (New_Restaurant) plus the company store master, keyed by Store ID. */
function indexStores(src, master) {
  const byId = new Map(), byShort = new Map(), inMaster = new Map();
  for (const r of src.records) {
    const id = String(r.Store_ID || "").trim();
    if (!id) continue;
    byId.set(id, { id, name: placeName(r.Restaurant_Name || r.Store_Name || id), active: String(r.isActive) !== "false" });
    const short = String(r.Restaurant_ID || "").trim();
    if (short) byShort.set(short, id);
  }
  for (const m of (master && master.stores) || []) {
    inMaster.set(m.storeId, m);
    if (m.restId && !byShort.has(m.restId)) byShort.set(m.restId, m.storeId);
  }
  return { available: src.available, byId, byShort, inMaster };
}

function loadHistory(dir) {
  return readJson(join(dir, "store-history.json"), {});
}

/** Keep each day's sales per restaurant, the baseline for spotting quiet ones. */
function rememberDay(history, summary) {
  history[summary.date] = Object.fromEntries(summary.stores.filter((s) => s.id).map((s) => [s.id, s.sales]));
  for (const d of Object.keys(history).sort().slice(0, -90)) delete history[d];
}

function indexMembers(src) {
  const byId = new Map(), byPhone = new Map();
  for (const r of src.records) {
    const m = { id: r.ID, name: String(r.Name || "").trim(), phone: r.Phone_Number || "", dob: r.Date_Of_Birth || "", email: String(r.Email || "").toLowerCase() };
    byId.set(r.ID, m);
    const d = digits(m.phone);
    if (d) byPhone.set(d, m);
  }
  return { available: src.available && src.complete, count: src.records.length, byId, byPhone };
}

/** The engine retries a phone with a 0 after the country code, so match both ways. */
function memberByPhone(members, phone) {
  const d = digits(phone);
  if (!d) return null;
  return members.byPhone.get(d) || members.byPhone.get(d.replace(/^9710/, "971")) ||
    members.byPhone.get(d.replace(/^971/, "9710")) || null;
}

// ---------------------------------------------------------------------------
// Till (POS) calls: ApiLog rows written by executeLoyaltyProgramme_V2, whose
// payload is a Deluge map printed as text, e.g.
// {loyalty_brand=0, phone_number=+9715..., type=3, transaction={country=1, restaurant_id=135100, ...}}
// ---------------------------------------------------------------------------

function kv(s, key) {
  const m = s.match(new RegExp(`[{ ,]${key}=([^,}]*)`));
  if (!m) return null;
  const v = m[1].trim();
  return v === "null" || v === "" ? null : v;
}

function parsePos(r) {
  const p = String(r.Request_Pay_load || "");
  if (!p) return null;
  const cut = p.indexOf("transaction=");
  const outer = cut >= 0 ? p.slice(0, cut) : p;
  const inner = cut >= 0 ? p.slice(cut) : "";
  const ms = parseZ(r.Modified_Time || r.Added_Time);
  return {
    ms, at: clock(ms), type: num(kv(outer, "type")), brand: kv(outer, "loyalty_brand"),
    phone: kv(outer, "phone_number"), store: kv(inner, "restaurant_id"), order: kv(inner, "order_id"),
    pts: num(kv(inner, "redeemable_points")), total: num(kv(inner, "total_invoice_amount")),
    otherReward: ["free_drink", "membership_discount", "catalog_offer"].some((k) => kv(inner, k) !== null),
  };
}

// ---------------------------------------------------------------------------
// NCR log classification
// ---------------------------------------------------------------------------

const NCR_GROUPS = [
  { key: "engine", label: "Loyalty engine errors", test: (t) => /^Function - loyaltyEngine\./.test(t) },
  { key: "crm", label: "CRM push errors", test: (t) => /crmIntegration/i.test(t) },
  { key: "signup", label: "Sign-up failures", test: (t) => t === "createNewCustomer" },
  { key: "profile", label: "Profile update failures", test: (t) => /^update profile$/i.test(t) },
  { key: "expiry", label: "Expiry jobs", test: (t) => /expir/i.test(t) },
  { key: "fix", label: "Manual fixes", test: (t) => /\bfix\b/i.test(t) },
];

/** Collapse ids, numbers and quoted values so repeats of one error group together. */
const shape = (msg) => maskEmails(msg).replace(/'[^']*'/g, "'…'").replace(/\d+(\.\d+)?/g, "#").slice(0, 160);

// ---------------------------------------------------------------------------
// One day's report
// ---------------------------------------------------------------------------

function buildDay(D, src, { mode, master = null, history = {} }) {
  const F = isoToMs(D), T = F + DAY_MS;
  const inDay = (ms) => ms !== null && ms >= F && ms < T;
  const full = mode === "full";
  const flags = [];
  const flag = (severity, section, title, detail) => flags.push({ severity, section, title, detail });

  const stores = indexStores(src.stores, master);
  const members = indexMembers(src.members);
  const fromMaster = (id) => { const m = stores.inMaster.get(id); return m ? placeName(m.name) || m.display : ""; };
  const storeName = (id) => (stores.byId.get(id) || {}).name || fromMaster(id) || (id ? `Unknown store ${id}` : "No store");
  const emirateOf = (id) => (stores.inMaster.get(id) || {}).emirate || "";

  // ---- transactions -------------------------------------------------------
  const txAll = src.transactions.records;
  const tx = txAll.filter((r) => inDay(parseZ(r.Transaction_Time)));
  const sales = tx.filter((r) => SALE_TYPES.has(r.Type_field));
  const cancels = tx.filter((r) => r.Type_field === "Cancellation");
  const bonus = tx.filter((r) => r.Type_field === "Bonus");
  const expired = tx.filter((r) => r.Type_field === "Expiration");

  const saleByOrder = new Map();
  for (const r of txAll) if (r.Order_ID && SALE_TYPES.has(r.Type_field)) saleByOrder.set(r.Order_ID, r);
  const cancelledOrders = new Set(txAll.filter((r) => r.Type_field === "Cancellation" || r.Status === "Cancelled").map((r) => r.Order_ID).filter(Boolean));

  const storeRows = new Map();
  const S = (id) => {
    const key = id || "";
    if (!storeRows.has(key)) {
      storeRows.set(key, { id: key, name: storeName(key), sales: 0, aed: 0, discount: 0, paid: 0, earned: 0, burned: 0,
        redemptions: 0, refunds: 0, posts: 0, lost: 0, lostPoints: 0, customers: new Set() });
    }
    return storeRows.get(key);
  };
  const hourly = Array(24).fill(0);
  const customersToday = new Set();
  const burnedOf = (r) => num(r.Burned_Points) + num(r.Bonus_Points_Burned);

  let aed = 0, discount = 0, paid = 0, earned = 0, burned = 0, redemptions = 0;
  for (const r of sales) {
    const s = S(r["Restaurant_Name.Store_ID"]);
    const inv = num(r.Total_Invoice_Amount), dis = num(r.Total_Discount_Amount), pay = num(r.Total_Purchase_Amount);
    const e = num(r.Earned_Loyalty_Points), b = burnedOf(r);
    s.sales++; s.aed += inv; s.discount += dis; s.paid += pay; s.earned += e; s.burned += b;
    aed += inv; discount += dis; paid += pay; earned += e; burned += b;
    if (b > 0 || dis > 0) { s.redemptions++; redemptions++; }
    const c = custId(r);
    if (c) { s.customers.add(c); customersToday.add(c); }
    const ms = parseZ(r.Transaction_Time);
    hourly[new Date(ms).getUTCHours()]++;
  }
  for (const r of cancels) S(r["Restaurant_Name.Store_ID"]).refunds++;

  const bonusOf = (type) => bonus.filter((r) => String(r.Bonus_Type).toLowerCase() === type);
  const signupBonus = bonusOf("sign up"), referralBonus = bonusOf("referral"), birthdayBonus = bonusOf("birthday");
  const sumPts = (rows, f) => rows.reduce((a, r) => a + num(r[f]), 0);

  // ---- till calls ---------------------------------------------------------
  const pos = src.pos.available ? src.pos.records.map(parsePos).filter((p) => p && inDay(p.ms)) : [];
  const kk = pos.filter((p) => p.brand === "2");
  const peets = pos.filter((p) => p.brand !== "2");
  const ncr = src.ncr.available
    ? src.ncr.records.map((r) => ({ ms: parseZ(r.Added_Time), title: String(r.Title || "(no title)").trim(), message: String(r.error || "") }))
        .filter((x) => inDay(x.ms)).sort((a, b) => a.ms - b.ms)
    : [];
  const engineErrors = ncr.filter((x) => NCR_GROUPS[0].test(x.title)).map((x) => ({ ...x, used: false }));

  // ok: in Zoho's store list. short: a 35xxx code for a 135xxx store. missing: in the
  // company store master but not in Zoho. unknown: in neither.
  const storeCheck = (code) => {
    if (!code || !stores.available) return "ok";
    if (stores.byId.has(code)) return "ok";
    if (stores.byShort.has(code)) return "short";
    return stores.inMaster.has(code) ? "missing" : "unknown";
  };

  const postsByOrder = new Map();
  for (const p of peets.filter((p) => p.type === 3 && p.order)) {
    const e = postsByOrder.get(p.order);
    if (e) { e.posts++; Object.assign(e, { pts: p.pts || e.pts, total: p.total || e.total }); } else postsByOrder.set(p.order, { ...p, posts: 1 });
  }
  const approvals = new Map();
  for (const p of peets.filter((p) => p.type === 5 && p.order)) approvals.set(p.order, p);

  const lostSales = [], notMembers = [], pointsNotBurned = [];
  for (const p of postsByOrder.values()) {
    const s = S(p.store);
    s.posts++;
    const saved = saleByOrder.get(p.order);
    const member = memberByPhone(members, p.phone);
    if (saved) {
      const b = burnedOf(saved);
      if (p.pts > 0 && b + 0.5 < p.pts) {
        pointsNotBurned.push({ at: p.at, store: p.store, storeName: s.name, order: p.order, customer: custName(saved),
          requested: p.pts, burned: b, discount: num(saved.Total_Discount_Amount) });
      }
      continue;
    }
    const check = storeCheck(p.store);
    const err = engineErrors.find((x) => !x.used && x.ms >= p.ms - 2000 && x.ms <= p.ms + 15000);
    if (err) err.used = true;
    let reason, reasonText;
    if (check === "missing") { reason = "missing-store"; reasonText = `${storeName(p.store)} is in the store master but not in Zoho's store list`; }
    else if (check === "unknown") { reason = "unknown-store"; reasonText = `Store code ${p.store} is in neither Zoho's store list nor the store master`; }
    else if (check === "short") { reason = "short-code"; reasonText = `Short store code ${p.store} (should be ${stores.byShort.get(p.store)})`; }
    else if (err) { reason = "engine-error"; reasonText = maskEmails(err.message).slice(0, 200); }
    else if (members.available && !member) { reason = "not-member"; reasonText = "Phone is not a member"; }
    else { reason = "not-saved"; reasonText = "No transaction saved and no error logged"; }
    const item = { at: p.at, store: p.store, storeName: s.name, order: p.order, phone: maskPhone(p.phone),
      customer: member ? member.name : "", points: p.pts, aed: p.total, posts: p.posts, reason, reasonText };
    if (reason === "not-member") { notMembers.push(item); continue; }
    lostSales.push(item);
    s.lost++; s.lostPoints += p.pts;
  }

  // An engine error on a sale that is saved now means someone entered it again later.
  for (const x of engineErrors.filter((e) => !e.used)) {
    const p = peets.find((q) => q.type === 3 && q.ms >= x.ms - 15000 && q.ms <= x.ms + 2000 && saleByOrder.has(q.order));
    if (p) { x.used = true; x.savedLater = true; }
  }
  const voided = new Set(peets.filter((p) => p.type === 4 && p.order).map((p) => p.order));

  const approvalsNoSale = [];
  for (const a of approvals.values()) {
    if (a.pts <= 0 || postsByOrder.has(a.order) || saleByOrder.has(a.order) || voided.has(a.order)) continue;
    const member = memberByPhone(members, a.phone);
    approvalsNoSale.push({ at: a.at, store: a.store, storeName: storeName(a.store), order: a.order,
      phone: maskPhone(a.phone), customer: member ? member.name : "", points: a.pts, aed: r2(a.pts / POINTS_PER_AED) });
  }

  const refundPosts = [];
  const seenRefund = new Set();
  for (const p of peets.filter((p) => p.type === 4)) {
    if (seenRefund.has(p.order)) continue;
    seenRefund.add(p.order);
    const store = stores.byShort.get(p.store) || p.store;
    const status = !p.phone ? "ignored-no-phone" : cancelledOrders.has(p.order) ? "recorded" : "not-recorded";
    refundPosts.push({ at: p.at, store, storeName: storeName(store), sentCode: p.store, order: p.order, status });
  }

  const badCodes = {};
  for (const p of peets.filter((p) => (p.type === 3 || p.type === 5) && p.store)) {
    const check = storeCheck(p.store);
    if (check !== "ok") (badCodes[p.store] ||= { code: p.store, kind: check, posts: 0, name: storeName(p.store), correct: stores.byShort.get(p.store) || null }).posts++;
  }

  // Free redemptions visible in the transactions alone: a discount with nothing burned.
  const posByOrder = new Map([...postsByOrder.values()].map((p) => [p.order, p]));
  const freeDiscounts = [];
  for (const r of sales) {
    const dis = num(r.Total_Discount_Amount);
    if (dis <= 0 || burnedOf(r) > 0) continue;
    const p = posByOrder.get(r.Order_ID);
    if (p && p.otherReward) continue; // free drink / tier discount / catalogue offer, not points
    freeDiscounts.push({ at: clock(parseZ(r.Transaction_Time)), store: r["Restaurant_Name.Store_ID"], storeName: storeName(r["Restaurant_Name.Store_ID"]),
      order: r.Order_ID, customer: custName(r), discount: dis, pointsWorth: dis * POINTS_PER_AED, tillSaid: p ? `${p.pts} pts` : "no till record" });
  }

  // ---- NCR logs -----------------------------------------------------------
  const ncrGroups = NCR_GROUPS.map((g) => ({ key: g.key, label: g.label, rows: [] })).concat([{ key: "other", label: "Other logs", rows: [] }]);
  for (const x of ncr) (ncrGroups.find((g) => g.key !== "other" && NCR_GROUPS.find((n) => n.key === g.key).test(x.title)) || ncrGroups.at(-1)).rows.push(x);
  const ncrSummary = ncrGroups.filter((g) => g.rows.length).map((g) => {
    const shapes = {};
    for (const x of g.rows) {
      const k = `${x.title} :: ${shape(x.message)}`;
      (shapes[k] ||= { title: x.title, sample: maskEmails(x.message).slice(0, 300), count: 0, first: clock(x.ms), last: clock(x.ms) }).count++;
      shapes[k].last = clock(x.ms);
    }
    return { key: g.key, label: g.label, count: g.rows.length, messages: Object.values(shapes).sort((a, b) => b.count - a.count).slice(0, 12) };
  });
  const ncrCount = (key) => (ncrSummary.find((g) => g.key === key) || { count: 0 }).count;
  const crmLimit = ncr.some((x) => /crmIntegration/i.test(x.title) && /MAX_RECORDS_LIMIT_REACHED/.test(x.message));

  const expiryLogs = ncr.filter((x) => /expir/i.test(x.title)).map((x) => {
    const m = /customers due:\s*(\d+),\s*processed:\s*(\d+),\s*failed:\s*(\d+)/i.exec(x.message);
    return { at: clock(x.ms), title: x.title, message: maskEmails(x.message).slice(0, 300),
      due: m ? +m[1] : null, processed: m ? +m[2] : null, failed: m ? +m[3] : null };
  });
  const tierRows = src.tier.available ? src.tier.records.filter((r) => inDay(parseZ(r.Added_Time))) : [];

  // ---- expiry -------------------------------------------------------------
  const expiredCustomers = new Set(expired.map(custId).filter(Boolean));
  const expiredPoints = sumPts(expired, "Bonus_Expiration");
  let backlog = null;
  if (src.backlog.available) {
    const rows = src.backlog.records;
    const withCust = rows.filter((r) => custId(r));
    const orphans = rows.filter((r) => !custId(r));
    const byCust = new Map();
    for (const r of withCust) {
      const e = byCust.get(custId(r)) || { id: custId(r), name: custName(r), points: 0, rows: 0, oldest: r.BonusValidity };
      e.points += num(r.Remaining_Bonus_Points); e.rows++;
      if (parseZ(r.BonusValidity) < parseZ(e.oldest)) e.oldest = r.BonusValidity;
      byCust.set(e.id, e);
    }
    backlog = {
      asOf: new Date().toISOString(), rows: withCust.length, customers: byCust.size,
      points: sumPts(withCust, "Remaining_Bonus_Points"), orphanRows: orphans.length,
      orphanPoints: sumPts(orphans, "Remaining_Bonus_Points"),
      top: [...byCust.values()].sort((a, b) => b.points - a.points).slice(0, 25),
    };
  }

  // ---- sign-ups and referrals ---------------------------------------------
  const signups = src.signups.available
    ? src.signups.records.filter((r) => inDay(parseZ(r.Added_Time))).map((r) => ({ id: r.ID, ms: parseZ(r.Added_Time), name: String(r.Name || "").trim(),
        phone: r.Phone_Number || "", dob: r.Date_Of_Birth || "", email: String(r.Email || "").toLowerCase() }))
    : signupBonus.map((r) => ({ id: custId(r), ms: parseZ(r.Transaction_Time), name: custName(r), phone: r["Customer.Phone_Number"] || "", dob: "", email: "" }));
  signups.sort((a, b) => a.ms - b.ms);

  const refToday = referralBonus.map((r) => ({ ms: parseZ(r.Transaction_Time), id: custId(r), name: custName(r), points: num(r.Bonus_Points_earned) }));
  const ref30 = src.referrals30.available
    ? src.referrals30.records.map((r) => ({ ms: parseZ(r.Transaction_Time), id: custId(r) }))
    : txAll.filter((r) => r.Type_field === "Bonus" && String(r.Bonus_Type).toLowerCase() === "referral").map((r) => ({ ms: parseZ(r.Transaction_Time), id: custId(r) }));
  const referredBy = new Map();
  const pairs = [];
  for (const ref of refToday) {
    const near = signups.filter((s) => Math.abs(s.ms - ref.ms) <= 2000 && s.id !== ref.id);
    const referee = near.sort((a, b) => Math.abs(a.ms - ref.ms) - Math.abs(b.ms - ref.ms))[0] || null;
    if (referee) referredBy.set(referee.id, ref);
    const referrer = members.byId.get(ref.id) || null;
    const signs = [];
    if (referee && referrer) {
      const a = digits(referrer.phone), b = digits(referee.phone);
      if (a && b && a.length === b.length && [...a].filter((ch, i) => ch !== b[i]).length <= 1) signs.push("phone differs by one digit");
      if (referrer.dob && referrer.dob === referee.dob) signs.push("same date of birth");
      const local = (e) => e.split("@")[0].replace(/[^a-z]/g, "");
      if (referrer.email && referee.email && local(referrer.email).length >= 4 && local(referrer.email) === local(referee.email)) signs.push("same email name");
    }
    pairs.push({ at: clock(ref.ms), referrer: ref.name, referrerId: ref.id, referee: referee ? referee.name : "",
      refereeId: referee ? referee.id : "", refereePhone: referee ? maskPhone(referee.phone) : "", points: ref.points, signs });
  }
  const byReferrer = new Map();
  for (const p of pairs) {
    const e = byReferrer.get(p.referrerId) || { id: p.referrerId, name: p.referrer, today: 0, times: [] };
    e.today++; e.times.push(parseZ(`${fmtZ(F).slice(0, 11)} ${p.at}`));
    byReferrer.set(p.referrerId, e);
  }
  const referrers = [...byReferrer.values()].map((e) => {
    const in7 = ref30.filter((r) => r.id === e.id && r.ms >= F - 6 * DAY_MS && r.ms < T).length;
    const in30 = ref30.filter((r) => r.id === e.id && r.ms >= F - 29 * DAY_MS && r.ms < T).length;
    const t = e.times.sort((a, b) => a - b);
    let burst = 0;
    for (let i = 0; i < t.length; i++) burst = Math.max(burst, t.filter((x) => x >= t[i] && x < t[i] + 3600_000).length);
    return { id: e.id, name: e.name, today: e.today, last7: in7, last30: in30, maxInOneHour: burst };
  }).sort((a, b) => b.today - a.today || b.last30 - a.last30);

  const refereeIds = new Set(pairs.map((p) => p.refereeId).filter(Boolean));
  const refereesSpent = sales.filter((r) => refereeIds.has(custId(r)) && burnedOf(r) > 0)
    .map((r) => ({ at: clock(parseZ(r.Transaction_Time)), customer: custName(r), store: storeName(r["Restaurant_Name.Store_ID"]), burned: burnedOf(r) }));

  // ---- app orders -----------------------------------------------------------
  const orders = src.orders.available ? src.orders.records.map((r) => {
    const status = lookupText(r.Cart_Status) || (r.Cart_Status && r.Cart_Status.Status) || "";
    return { type: r.Type_field || "", status, payment: String(r.Payment_Status || ""), total: num(r.Total_Amount_s), subTotal: num(r.Sub_Total),
      points: num(r.Points_Redeem_values), coupon: num(r.Payment_Coupon_Discount_s), posId: String(r.Pos_orderid || ""),
      posMessage: String(r.Pos_Message || ""), method: lookupText(r.Method_of_Ordering) || (r.Method_of_Ordering && r.Method_of_Ordering.Facility_Type) || "",
      customer: custName(r), store: lookupText(r.Restaurant_Name_cart_order_all), placed: r.Order_Placed_On || "" };
  }) : [];
  const orderIssues = orders.filter((o) => o.type === "Failed Order" || (o.payment === "done" && !o.posId) ||
    (o.posMessage && !/placed successfully/i.test(o.posMessage)));

  // ---- app API usage --------------------------------------------------------
  const apiCounts = src.appapi.available ? countBy(src.appapi.records, (r) => String(r.Api_Type || "?")) : {};
  const appApi = Object.entries(apiCounts).map(([type, count]) => ({ type, label: APP_API_LABELS[type] || `type ${type}`, count }))
    .sort((a, b) => b.count - a.count);
  const deletions = apiCounts["28"] || 0;

  // ---- flags ----------------------------------------------------------------
  const storeList = (items) => Object.entries(countBy(items, "storeName")).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(", ");
  const unknownCodes = Object.values(badCodes);
  if (unknownCodes.length) {
    const one = unknownCodes.length === 1 && unknownCodes[0];
    const describe = (c) => c.kind === "missing" ? `${c.name} (${c.code}) is in the store master but not in Zoho's store list: ${c.posts} calls`
      : c.kind === "short" ? `${c.code} is the short form of ${c.correct}: ${c.posts} calls`
      : `${c.code} is in neither Zoho's store list nor the store master: ${c.posts} calls`;
    flag("critical", "sales", one && one.kind === "missing" ? `${one.name} sales can't be saved` : `Till is sending ${one ? "a store code" : `${unknownCodes.length} store codes`} Zoho doesn't know`,
      `${unknownCodes.map(describe).join("; ")}. Every sale from ${one ? "it" : "these"} fails to save until the store is added to Zoho's store list.`);
  }
  if (lostSales.length) {
    const pts = lostSales.reduce((a, x) => a + x.points, 0);
    const who = members.available ? "member sale" : "sale";
    flag("critical", "sales", `${lostSales.length} ${who}${lostSales.length === 1 ? "" : "s"} not saved`,
      `${storeList(lostSales)}. ${pts ? `${pts.toLocaleString("en-US")} points were redeemed on them and never burned. ` : ""}AED ${r2(lostSales.reduce((a, x) => a + x.aed, 0))} of sales.`);
  }
  if (pointsNotBurned.length) {
    const gap = pointsNotBurned.reduce((a, x) => a + x.requested - x.burned, 0);
    flag("warning", "points", `${pointsNotBurned.length} redemption${pointsNotBurned.length === 1 ? "" : "s"} burned fewer points than the till asked`,
      `${gap.toLocaleString("en-US")} points short in total.`);
  }
  if (freeDiscounts.length) {
    flag(full ? "warning" : "info", "points", `${freeDiscounts.length} sale${freeDiscounts.length === 1 ? "" : "s"} with a discount and no points burned`,
      `${storeList(freeDiscounts)}. Worth ${freeDiscounts.reduce((a, x) => a + x.pointsWorth, 0).toLocaleString("en-US")} points.${full ? "" : " Till data isn't kept this far back, so free-drink rewards can't be ruled out."}`);
  }
  if (approvalsNoSale.length) {
    flag("warning", "points", `${approvalsNoSale.length} redemption approval${approvalsNoSale.length === 1 ? "" : "s"} with no sale posted`,
      `The till approved ${approvalsNoSale.reduce((a, x) => a + x.points, 0).toLocaleString("en-US")} points but never sent the sale. Either the order was abandoned or the sale was lost.`);
  }
  const ignoredRefunds = refundPosts.filter((r) => r.status !== "recorded");
  if (ignoredRefunds.length) {
    const noPhone = ignoredRefunds.filter((r) => r.status === "ignored-no-phone").length;
    flag("warning", "refunds", `${ignoredRefunds.length} till refund${ignoredRefunds.length === 1 ? "" : "s"} not applied`,
      noPhone ? `${noPhone} arrived with no phone number, which the loyalty engine needs, so the points were never reversed.` : "No cancellation row was saved for them.");
  }
  if (engineErrors.length) {
    const later = engineErrors.filter((x) => x.savedLater).length;
    const unmatched = engineErrors.filter((x) => !x.used).length;
    const notes = [later && `${later} of those sales were entered again later`, unmatched && `${unmatched} not matched to a till call`].filter(Boolean);
    flag(later === engineErrors.length ? "warning" : "critical", "ncr", `${engineErrors.length} loyalty engine error${engineErrors.length === 1 ? "" : "s"} logged`,
      `${shape(engineErrors[0].message)}${notes.length ? ` (${notes.join("; ")})` : ""}`);
  }
  if (backlog && backlog.customers > 0) {
    flag(backlog.customers > 25 ? "critical" : "warning", "expiry", `${backlog.customers} customer${backlog.customers === 1 ? "" : "s"} still hold expired points`,
      `${backlog.points.toLocaleString("en-US")} points past their expiry date and still spendable.`);
  }
  const failedExpiry = expiryLogs.filter((x) => x.failed > 0);
  if (failedExpiry.length) {
    flag("warning", "expiry", "Expiry catch-up job had failures", failedExpiry.map((x) => `${x.at}: ${x.failed} failed`).join("; "));
  }
  if (full && src.ncr.available && !expiryLogs.length && expired.length === 0 && backlog && backlog.customers > 0) {
    flag("critical", "expiry", "No expiry job ran", "No expiry log and no expired points today, while expired points are waiting.");
  }
  for (const r of referrers) {
    const severity = r.today >= 5 || r.last30 >= 15 ? "critical" : r.today >= 3 || r.last30 >= 10 || r.maxInOneHour >= 3 ? "warning" : null;
    if (!severity) continue;
    flag(severity, "referrals", `${r.name}: ${r.today} referral bonus${r.today === 1 ? "" : "es"} today, ${r.last30} in 30 days`,
      `${r.last7} in the last 7 days; up to ${r.maxInOneHour} within one hour today.`);
  }
  const lookalikes = pairs.filter((p) => p.signs.length);
  if (lookalikes.length) {
    flag("warning", "referrals", `${lookalikes.length} referral${lookalikes.length === 1 ? "" : "s"} look like the same person`,
      lookalikes.slice(0, 5).map((p) => `${p.referrer} → ${p.referee} (${p.signs.join(", ")})`).join("; "));
  }
  if (crmLimit) {
    flag("warning", "ncr", "CRM contact limit reached", `${ncrCount("crm")} customer pushes to Zoho CRM failed: the CRM account is at its 5,000-record limit, so new members aren't reaching CRM.`);
  } else if (ncrCount("crm")) {
    flag("warning", "ncr", `${ncrCount("crm")} CRM push errors`, "See the NCR log section.");
  }
  if (ncrCount("signup") >= 3) flag("info", "signups", `${ncrCount("signup")} sign-up attempts failed`, "Mostly emails that already belong to another member.");
  if (orderIssues.length) {
    flag("warning", "orders", `${orderIssues.length} app order${orderIssues.length === 1 ? "" : "s"} need a look`,
      orderIssues.slice(0, 4).map((o) => `${o.customer || "?"}: ${o.type === "Failed Order" ? "failed" : !o.posId ? "paid, no POS order id" : o.posMessage}`).join("; "));
  }
  if (full && src.tier.available && tierRows.length === 0) flag("warning", "jobs", "Tier validation job left no log", "Membership tiers may not have been re-checked.");
  if (deletions) flag("info", "app", `${deletions} account deletion${deletions === 1 ? "" : "s"} from the app`, "Customers used Delete account.");
  if (members.available === false && full) flag("info", "data", "Member list not loaded", "Unsaved sales could not be checked against the member list.");
  const missing = Object.entries(src).filter(([k, v]) => !v.available && (full || ["transactions", "stores"].includes(k))).map(([k]) => k);
  if (full && missing.length) flag("info", "data", "Some data sources were not available", missing.join(", "));
  const incomplete = Object.entries(src).filter(([, v]) => v.available && !v.complete).map(([k]) => k);
  if (incomplete.length) flag("warning", "data", "Some reads hit their page cap", `${incomplete.join(", ")}: counts are a minimum.`);

  // ---- restaurants: every store Zoho or the store master knows, busy or not ---
  const storeTable = [...storeRows.values()].filter((s) => s.id && (s.sales || s.posts || s.refunds))
    .map((s) => ({ ...s, aed: r2(s.aed), discount: r2(s.discount), paid: r2(s.paid), customers: s.customers.size }))
    .sort((a, b) => b.sales - a.sales || b.posts - a.posts);
  const listed = new Set(storeTable.map((s) => s.id));
  const opened = (id) => { const m = stores.inMaster.get(id); return !m || !/^\d{4}-\d{2}-\d{2}$/.test(m.opened) || m.opened <= D; };
  const expected = [...[...stores.byId.values()].filter((s) => s.active).map((s) => s.id), ...stores.inMaster.keys()];
  for (const id of new Set(expected)) {
    if (listed.has(id) || !opened(id)) continue;
    storeTable.push({ id, name: storeName(id), sales: 0, aed: 0, discount: 0, paid: 0, earned: 0, burned: 0, redemptions: 0, refunds: 0, posts: 0, lost: 0, lostPoints: 0, customers: 0, quiet: true });
  }
  for (const s of storeTable) {
    s.emirate = emirateOf(s.id);
    s.known = !stores.available || stores.byId.has(s.id);
    s.inMaster = stores.inMaster.size ? stores.inMaster.has(s.id) : null;
  }

  // Quiet restaurants. "Usual" is the median for the same kind of day (the UAE weekend
  // is Saturday and Sunday) over the last 4 weeks, so office stores aren't flagged
  // every weekend. Stores selling under 2 a day are too small to call a gap.
  const isWeekend = (iso) => [0, 6].includes(new Date(isoToMs(iso)).getUTCDay());
  const past28 = Object.keys(history).filter((d) => d < D && d >= addDays(D, -28)).sort();
  const recent = past28.filter((d) => d >= addDays(D, -BASELINE_DAYS));
  const sameKind = past28.filter((d) => isWeekend(d) === isWeekend(D)).slice(-10);
  if (recent.length >= 5 && sameKind.length >= 3) {
    const salesOn = (d, id) => (history[d] && history[d][id]) || 0;
    const kind = isWeekend(D) ? "weekend day" : "weekday";
    const drops = [], stopped = [], never = [];
    for (const s of storeTable) {
      const like = sameKind.map((d) => salesOn(d, s.id)).sort((a, b) => a - b);
      const usual = like[Math.floor(like.length / 2)];
      const last = recent.map((d) => salesOn(d, s.id));
      const perDay = last.reduce((a, x) => a + x, 0) / last.length;
      let streak = 0;
      if (!s.sales) { streak = 1; for (let i = last.length - 1; i >= 0 && last[i] === 0; i--) streak++; }
      const m = stores.inMaster.get(s.id);
      const settled = !m || !/^\d{4}-\d{2}-\d{2}$/.test(m.opened) || m.opened <= addDays(D, -7);
      if (usual >= 8 && s.sales <= usual * 0.2) drops.push({ ...s, usual });
      else if (streak >= 3 && settled && perDay >= 2) stopped.push({ ...s, streak });
      else if (streak > last.length && settled && s.known) never.push(s);
    }
    if (drops.length) {
      flag("warning", "stores", drops.length === 1 ? `${drops[0].name} sent far fewer loyalty sales than usual` : `${drops.length} restaurants sent far fewer loyalty sales than usual`,
        `${drops.map((s) => `${s.name}: ${s.sales} today, usually about ${s.usual} on a ${kind}`).join("; ")}. A till or connection problem can stop sales reaching Zoho.`);
    }
    if (stopped.length) {
      flag("warning", "stores", stopped.length === 1 ? `${stopped[0].name}: no loyalty sales for ${stopped[0].streak} days` : `${stopped.length} restaurants with no loyalty sales for 3 days or more`,
        `${stopped.map((s) => `${s.name} (${s.streak} days)`).join("; ")}. They normally have a few a day.`);
    }
    if (never.length) {
      flag("warning", "stores", `${never.length} restaurant${never.length === 1 ? "" : "s"} with no loyalty sales in ${recent.length + 1} days`,
        `${never.map((s) => `${s.name} (${s.id})`).join("; ")}. They're in Zoho's store list, so their tills may not be sending loyalty sales at all.`);
    }
  }

  // The store master against Zoho's store list.
  if (stores.available && stores.inMaster.size) {
    const flaggedCodes = new Set(unknownCodes.map((c) => c.code));
    const notInZoho = [...stores.inMaster.values()].filter((m) => !stores.byId.has(m.storeId) && !flaggedCodes.has(m.storeId));
    if (notInZoho.length) {
      flag("info", "stores", `${notInZoho.length} store${notInZoho.length === 1 ? "" : "s"} from the store master missing from Zoho's store list`,
        `${notInZoho.map((m) => `${storeName(m.storeId)} (${m.storeId}, ${m.emirate})`).join("; ")}. Their loyalty sales would fail to save.`);
    }
    const notInMaster = [...stores.byId.values()].filter((s) => s.active && !stores.inMaster.has(s.id));
    if (notInMaster.length) {
      flag("info", "stores", `${notInMaster.length} active Zoho store${notInMaster.length === 1 ? "" : "s"} not in the store master`, notInMaster.map((s) => `${s.name} (${s.id})`).join("; "));
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);
  const flagCounts = countBy(flags, "severity");
  const status = flagCounts.critical ? "critical" : flagCounts.warning ? "warning" : "ok";

  // ---- assemble ---------------------------------------------------------------

  const kpis = {
    sales: sales.length, salesAed: r2(aed), discountAed: r2(discount), paidAed: r2(paid),
    avgTicket: sales.length ? r2(aed / sales.length) : 0, customers: customersToday.size,
    pointsEarned: earned, pointsBurned: burned, redemptions,
    refunds: cancels.length, refundPosts: refundPosts.length,
    signups: signups.length, signupBonusPoints: sumPts(signupBonus, "Bonus_Points_earned"),
    referrals: refToday.length, referralPoints: sumPts(referralBonus, "Bonus_Points_earned"),
    birthdays: birthdayBonus.length, birthdayPoints: sumPts(birthdayBonus, "Bonus_Points_earned"),
    expiredRows: expired.length, expiredCustomers: expiredCustomers.size, expiredPoints,
    lostSales: lostSales.length, lostPoints: lostSales.reduce((a, x) => a + x.points, 0),
    pointsNotBurned: pointsNotBurned.length + freeDiscounts.length, approvalsNoSale: approvalsNoSale.length,
    tillCalls: peets.length, tillSalePosts: postsByOrder.size, kkCalls: kk.length,
    appOrders: orders.filter((o) => o.type !== "Cart").length, appOrdersAed: r2(orders.reduce((a, o) => a + o.total, 0)),
    appOrderIssues: orderIssues.length, appCarts: src.carts.available ? src.carts.count : null,
    appApiCalls: src.appapi.available ? src.appapi.count : null, ncrLogs: ncr.length,
    members: members.available ? members.count : null,
  };
  const sources = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, { available: v.available, count: v.count, complete: v.complete }]));
  const headline = status === "ok" ? "No issues found" : flags[0].title;

  const summary = {
    date: D, weekday: weekday(D), mode, generatedAt: new Date().toISOString(), status, headline,
    flagCounts: { critical: flagCounts.critical || 0, warning: flagCounts.warning || 0, info: flagCounts.info || 0 },
    topFlags: flags.slice(0, 6).map((f) => ({ severity: f.severity, title: f.title })),
    kpis, stores: storeTable, sources,
    storeMaster: master ? { source: master.source, extracted: master.extracted, stores: master.stores.length } : null,
  };
  const detail = {
    ...summary, flags, hourly,
    sections: {
      lostSales: lostSales.slice(0, LIST_CAP), notMembers: { count: notMembers.length, sample: notMembers.slice(0, 50) },
      pointsNotBurned: pointsNotBurned.slice(0, LIST_CAP), freeDiscounts: freeDiscounts.slice(0, LIST_CAP),
      approvalsNoSale: approvalsNoSale.slice(0, LIST_CAP), refunds: refundPosts.slice(0, LIST_CAP),
      storeCodes: unknownCodes,
      till: full ? { byType: countBy(peets, (p) => `type ${p.type}`), hourly: hourlyOf(peets), kk: countBy(kk, (p) => `type ${p.type}`) } : null,
      expiry: { rows: expired.length, customers: expiredCustomers.size, points: expiredPoints,
        byType: countBy(expired, (r) => r.Bonus_Type || "?"), jobs: expiryLogs, backlog },
      referrals: { count: refToday.length, points: kpis.referralPoints, pairs: pairs.slice(0, LIST_CAP), referrers: referrers.slice(0, 100), refereesSpent: refereesSpent.slice(0, 100) },
      signups: { count: signups.length, hourly: hourlyOf(signups), referred: referredBy.size, failed: ncrCount("signup"),
        list: signups.slice(0, LIST_CAP).map((s) => ({ at: clock(s.ms), name: s.name, phone: maskPhone(s.phone), referredBy: (referredBy.get(s.id) || {}).name || "" })) },
      ncr: { count: ncr.length, groups: ncrSummary, tierJob: src.tier.available ? { rows: tierRows.length, capped: !src.tier.complete, first: tierRows.length ? clock(Math.min(...tierRows.map((r) => parseZ(r.Added_Time)))) : null } : null },
      appOrders: { orders: orders.slice(0, LIST_CAP), issues: orderIssues.length, carts: kpis.appCarts,
        byStatus: countBy(orders, "status"), byMethod: countBy(orders, "method"), points: orders.reduce((a, o) => a + o.points, 0) },
      appApi: { total: kpis.appApiCalls, byType: appApi },
    },
  };
  return { summary, detail: fit(detail) };
}

function hourlyOf(items) {
  const h = Array(24).fill(0);
  for (const it of items) if (it.ms !== null && it.ms !== undefined) h[new Date(it.ms).getUTCHours()]++;
  return h;
}

/** Trim the longest lists until the document fits the dashboard store's size limit. */
function fit(doc) {
  const lists = () => {
    const s = doc.sections;
    return [["lostSales", s], ["pointsNotBurned", s], ["freeDiscounts", s], ["approvalsNoSale", s], ["refunds", s],
      ["pairs", s.referrals], ["list", s.signups], ["orders", s.appOrders], ["referrers", s.referrals], ["refereesSpent", s.referrals]]
      .filter(([k, o]) => o && Array.isArray(o[k]) && o[k].length > 20);
  };
  let bytes = Buffer.byteLength(JSON.stringify(doc));
  while (bytes > DOC_BUDGET_BYTES) {
    const candidates = lists();
    if (!candidates.length) break;
    const [key, owner] = candidates.sort((a, b) => JSON.stringify(b[1][b[0]]).length - JSON.stringify(a[1][a[0]]).length)[0];
    const keep = Math.floor(owner[key].length / 2);
    doc.truncated = { ...(doc.truncated || {}), [key]: (doc.truncated?.[key] || 0) + owner[key].length - keep };
    owner[key] = owner[key].slice(0, keep);
    bytes = Buffer.byteLength(JSON.stringify(doc));
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function writeReport(dir, built, { summary, detail }) {
  const summaryFile = join(dir, `summary-${summary.date}.json`);
  const dayFile = join(dir, `day-${summary.date}.json`);
  const dayText = JSON.stringify(detail);
  writeFileSync(summaryFile, JSON.stringify(summary));
  writeFileSync(dayFile, dayText);
  built.push({
    date: summary.date, status: summary.status, headline: summary.headline, flags: summary.flagCounts,
    sales: summary.kpis.sales, lostSales: summary.kpis.lostSales, summaryFile, dayFile, dayBytes: Buffer.byteLength(dayText),
    missingSources: Object.entries(summary.sources).filter(([, v]) => !v.available).map(([k]) => k),
  });
}

function cmdBuild(opts) {
  const dir = outDir(opts);
  const inDir = typeof opts.in === "string" ? resolve(opts.in) : null;
  const plan = readJson(join(dir, "plan.json"), null);
  const days = opts.date ? [].concat(opts.date).map(checkIso) : plan ? plan.days : fail(`No plan.json in ${dir} - run plan first.`);
  const runTag = typeof opts.run === "string" ? opts.run : plan && plan.runTag;
  const shared = {
    stores: loadSource(runTag && findExport(`peets-run${runTag}-stores.json`, inDir)),
    members: loadSource(runTag && findExport(`peets-run${runTag}-members.json`, inDir)),
  };
  const master = loadMaster();
  const history = loadHistory(dir);
  const built = [];
  for (const D of [...days].sort()) {
    const src = { ...shared };
    for (const name of DAY_SOURCES) src[name] = loadSource(findExport(`peets-${D}-${name}.json`, inDir));
    if (!src.transactions.available) {
      fail(`No peets-${D}-transactions.json in ${[inDir, ...EXPORT_DIRS].filter(Boolean).join(" or ")} - make the plan's calls first, or pass --in with the folder the connector reported as savedTo.`);
    }
    const report = buildDay(D, src, { mode: "full", master, history });
    rememberDay(history, report.summary);
    writeReport(dir, built, report);
  }
  writeFileSync(join(dir, "store-history.json"), JSON.stringify(history));
  console.log(JSON.stringify({ built }, null, 1));
}

function cmdHistory(opts) {
  const dir = outDir(opts);
  const from = checkIso(opts.from), to = checkIso(opts.to);
  if (typeof opts.tx !== "string") fail("history needs --tx FILE (a transactions export covering the range).");
  const transactions = loadSource(resolve(opts.tx));
  if (!transactions.available) fail(`${opts.tx} not found.`);
  const base = {
    transactions,
    stores: typeof opts.stores === "string" ? loadSource(resolve(opts.stores)) : unavailable(),
    signups: typeof opts.signups === "string" ? loadSource(resolve(opts.signups)) : unavailable(),
    members: unavailable(), pos: unavailable(), appapi: unavailable(), ncr: unavailable(), tier: unavailable(),
    orders: unavailable(), carts: unavailable(), backlog: unavailable(), referrals30: unavailable(),
  };
  const master = loadMaster();
  const history = loadHistory(dir);
  const built = [];
  for (let D = from; D <= to; D = addDays(D, 1)) {
    const report = buildDay(D, base, { mode: "history", master, history });
    rememberDay(history, report.summary);
    writeReport(dir, built, report);
  }
  writeFileSync(join(dir, "store-history.json"), JSON.stringify(history));
  console.log(JSON.stringify({ built: built.map(({ date, status, headline, sales, dayBytes }) => ({ date, status, headline, sales, dayBytes })), outDir: dir }, null, 1));
}

function cmdMark(opts) {
  const dir = outDir(opts);
  const state = loadState(dir);
  const dates = [].concat(opts.date || []).map(checkIso);
  if (!dates.length) fail("mark needs --date YYYY-MM-DD (repeat for several days).");
  state.published = [...new Set([...state.published, ...dates])].sort().slice(-400);
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 1));
  console.log(JSON.stringify({ published: dates, stateFile: join(dir, "state.json") }));
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) fail(`Unexpected argument ${rest[i]}`);
    const key = rest[i].slice(2);
    const value = rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[++i] : true;
    opts[key] = key in opts ? [].concat(opts[key], value) : value;
  }
  return { command, opts };
}

const { command, opts } = parseArgs(process.argv.slice(2));
const commands = { plan: cmdPlan, build: cmdBuild, history: cmdHistory, mark: cmdMark };
if (!commands[command]) {
  console.log("Usage: node daily-report.mjs plan|build|mark|history [options] - see the header of this file.");
  process.exit(command === "help" ? 0 : 1);
}
commands[command](opts);
