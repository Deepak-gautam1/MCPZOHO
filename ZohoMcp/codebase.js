/**
 * codebase.js
 *
 * A read-only index over the Zoho Creator `.ds` exports in ./Codebase.
 *
 * The live Creator API (zohoClient.js) answers "what data is in the app right now".
 * This module answers the complementary question - "what does the app actually DO":
 * which Deluge function implements a rule, what a form's on-add workflow runs, which
 * schedules are active and what they sweep, and who calls whom across the apps.
 *
 * Everything is derived from the export files; nothing here talks to Zoho. The index
 * is built lazily on first use and rebuilt automatically when a `.ds` file changes.
 *
 * Set ZOHO_CODEBASE_DIR to point at the exports if they do not live in ./Codebase.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { blockSettings, formFields, parseDs } from "./delugeParser.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Objects a user would name in a question; `block`/`attributes` are internal scaffolding. */
const PRIMARY_KINDS = new Set([
  "form",
  "report",
  "page",
  "function",
  "workflow",
  "schedule",
  "batchworkflow",
  "button",
]);

const AUTOMATION_KINDS = new Set(["workflow", "schedule", "batchworkflow", "button"]);

/** Nodes whose bodies contain Deluge worth scanning for call sites. */
const CODE_KINDS = new Set(["function", "script", "page"]);

const LIMITS = {
  searchResults: 200,
  outlineObjects: 2000,
  sourceLines: 3000,
  callSites: 300,
  snippet: 240,
};

let cache = null;

function codebaseDir() {
  return process.env.ZOHO_CODEBASE_DIR || path.join(HERE, "Codebase");
}

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

/** Stat every export plus apps.json, so any edit or addition invalidates the cache. */
function fingerprint(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".ds")).sort();
  } catch (err) {
    throw new Error(
      `Cannot read the Creator export directory ${dir}: ${err.message}. ` +
        "Set ZOHO_CODEBASE_DIR to the folder holding the .ds exports."
    );
  }
  const parts = [...files, "apps.json"].map((f) => {
    try {
      const st = fs.statSync(path.join(dir, f));
      return `${f}:${st.size}:${st.mtimeMs}`;
    } catch {
      return `${f}:absent`;
    }
  });
  return { files, key: parts.join("|") };
}

function getIndex() {
  const dir = codebaseDir();
  const { files, key } = fingerprint(dir);
  if (cache && cache.key === key && cache.dir === dir) return cache;
  cache = buildIndex(dir, files, key);
  return cache;
}

function buildIndex(dir, files, key) {
  if (files.length === 0) {
    throw new Error(`No .ds exports found in ${dir}. Export the apps from Creator into that folder.`);
  }

  const { exports: linkNames, externalApps } = readAppMetadata(dir);
  const apps = [];

  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const lines = text.split(/\r?\n/);
    const { application, nodes, warnings } = parseDs(text);

    const slug = file.replace(/\.ds$/i, "");
    const meta = linkNames[file] ?? linkNames[slug] ?? {};

    // One entry per source line naming the innermost node that owns it. Nodes arrive in
    // document order with parents before children, so later writes deepen the answer.
    const owner = new Int32Array(lines.length + 2).fill(-1);
    for (const node of nodes) {
      for (let ln = node.headerLine; ln <= node.endLine; ln += 1) owner[ln] = node.index;
    }

    const app = {
      file,
      slug,
      name: application ?? slug,
      linkName: meta.linkName ?? null,
      delugeName: delugeName(meta.linkName),
      owner: meta.owner ?? null,
      note: meta.note ?? null,
      lineCount: lines.length,
      lines,
      nodes,
      lineOwner: owner,
      warnings,
    };
    app.counts = countKinds(nodes);
    apps.push(app);
  }

  const index = { dir, key, apps, externalApps, byName: new Map(), byExternalName: new Map() };
  for (const app of apps) {
    for (const alias of [app.slug, app.name, app.linkName, app.delugeName].filter(Boolean)) {
      index.byName.set(alias.toLowerCase(), app);
    }
  }
  for (const [link, info] of Object.entries(externalApps)) {
    for (const alias of [link, delugeName(link)].filter(Boolean)) {
      index.byExternalName.set(alias.toLowerCase(), { linkName: link, ...info });
    }
  }
  buildCallGraph(index);
  return index;
}

/**
 * The form of a link name that Deluge uses to reference another app. Creator link names
 * are hyphenated (`test-peets-new`) but hyphens cannot appear in a Deluge identifier, so
 * cross-app calls spell the same app `test_peets_new`.
 */
function delugeName(linkName) {
  return linkName ? linkName.replace(/-/g, "_") : null;
}

/**
 * Optional sidecar `apps.json`: `{ exports: { "<file>.ds": { linkName, owner, note } },
 * externalApps: { "<link-name>": { application, note } } }`. Link names cannot be derived
 * from an export - Creator's link name and display name often differ arbitrarily - so this
 * file is the only place that mapping can come from. A flat `{ "<file>.ds": {...} }` object
 * is also accepted. Absent or malformed, everything still works with linkName null.
 */
function readAppMetadata(dir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "apps.json"), "utf8"));
  } catch {
    return { exports: {}, externalApps: {} };
  }
  if (raw && typeof raw === "object" && raw.exports) {
    return { exports: raw.exports ?? {}, externalApps: raw.externalApps ?? {} };
  }
  const flat = Object.fromEntries(Object.entries(raw ?? {}).filter(([k]) => !k.startsWith("_")));
  return { exports: flat, externalApps: {} };
}

function countKinds(nodes) {
  const counts = {};
  for (const n of nodes) {
    if (PRIMARY_KINDS.has(n.kind)) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Call graph
// ---------------------------------------------------------------------------

/** `thisapp.ns.fn(`, `other_app.ns.fn(`, `ns.fn(` and bare `fn(`. */
const CALL_RE = /\b([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*\(/g;

/**
 * Resolve call sites by matching against the set of function names that actually exist
 * in the exports. Filtering that way discards the `zoho.crm.getRecords()` and
 * `input.ID.toString()` noise that a purely syntactic scan would drown in.
 */
function buildCallGraph(index) {
  const byBareName = new Map(); // fn name -> [{app, node}]
  for (const app of index.apps) {
    for (const node of app.nodes) {
      if (node.kind !== "function") continue;
      const list = byBareName.get(node.name) ?? [];
      list.push({ app, node });
      byBareName.set(node.name, list);
    }
  }

  const edges = []; // {app, node, line, callee, qualifier}
  for (const app of index.apps) {
    for (const node of app.nodes) {
      if (!CODE_KINDS.has(node.kind)) continue;
      for (let ln = node.startLine; ln <= node.endLine; ln += 1) {
        const raw = app.lines[ln - 1];
        if (!raw || !raw.includes("(")) continue;
        CALL_RE.lastIndex = 0;
        let m;
        while ((m = CALL_RE.exec(raw)) !== null) {
          const parts = m[1].split(".");
          const callee = parts[parts.length - 1];
          if (!byBareName.has(callee)) continue;
          edges.push({
            app,
            node,
            line: ln,
            callee,
            qualifier: parts.slice(0, -1).join("."),
          });
        }
      }
    }
  }

  const callersOf = new Map(); // callee name -> edges
  for (const e of edges) {
    const list = callersOf.get(e.callee) ?? [];
    list.push(e);
    callersOf.set(e.callee, list);
  }

  index.functionsByName = byBareName;
  index.callEdges = edges;
  index.callersOf = callersOf;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function resolveApps(index, appName) {
  if (!appName) return index.apps;
  const hit = index.byName.get(String(appName).toLowerCase());
  if (hit) return [hit];
  const known = index.apps.map((a) => a.slug).join(", ");
  throw new Error(`Unknown app "${appName}". Known apps (use slug, display name or link name): ${known}`);
}

function nodeAt(app, line) {
  const idx = app.lineOwner[line] ?? -1;
  return idx === -1 ? null : app.nodes[idx];
}

/** Walk up to the nearest node a person would name, e.g. the enclosing function. */
function primaryAncestor(app, node) {
  let cur = node;
  while (cur) {
    if (PRIMARY_KINDS.has(cur.kind)) return cur;
    cur = cur.parentIndex === -1 ? null : app.nodes[cur.parentIndex];
  }
  return null;
}

/** `batchworkflow Validate_User_Tier_Status > on execute > custom deluge script` */
function locationLabel(app, node) {
  if (!node) return null;
  const chain = [];
  let cur = node;
  while (cur) {
    if (cur.kind === "function") chain.unshift(`function ${cur.qualified}`);
    else if (PRIMARY_KINDS.has(cur.kind)) chain.unshift(`${cur.kind} ${cur.name}`);
    else if (cur.kind !== "section" && cur.kind !== "application") chain.unshift(cur.name);
    cur = cur.parentIndex === -1 ? null : app.nodes[cur.parentIndex];
  }
  return chain.join(" > ") || null;
}

function displayName(node) {
  return node.kind === "function" ? node.qualified : node.name;
}

function nodeRef(app, node) {
  return {
    app: app.slug,
    kind: node.kind,
    name: displayName(node),
    lines: `${node.headerLine}-${node.endLine}`,
  };
}

// ---------------------------------------------------------------------------
// Per-kind metadata
// ---------------------------------------------------------------------------

/** Which `on <event>` blocks a workflow/schedule actually defines. */
function eventBlocks(node) {
  return node.children.filter((c) => /^on\s/i.test(c.name)).map((c) => c.name);
}

function automationDetail(app, node) {
  const s = blockSettings(app.lines, node);
  return {
    ...nodeRef(app, node),
    display: node.display ?? s["display name"] ?? null,
    // `status` is absent on always-on form workflows; only schedules opt out explicitly.
    status: s.status ?? "active",
    triggerType: s.type ?? null,
    target: s.form ?? s.report ?? null, // may carry a criteria, e.g. Transaction[Status == "..."]
    recordEvent: s["record event"] ?? s.event ?? null,
    executionType: s["execution type"] ?? null,
    start: s.start ?? null,
    frequency: s.frequency ?? null,
    batchSize: s["batch size"] ?? null,
    timeZone: s["time zone"] ?? null,
    events: eventBlocks(node),
  };
}

function objectDetail(app, node) {
  const base = nodeRef(app, node);
  switch (node.kind) {
    case "function":
      return {
        ...base,
        namespace: node.namespace,
        signature: `${node.returnType} ${node.qualified}(${node.params})`,
      };
    case "form": {
      const s = blockSettings(app.lines, node);
      const fields = formFields(app.lines, node);
      return {
        ...base,
        display: s.displayname ?? null,
        fieldCount: fields.length,
        fields: fields.map((f) => ({
          name: f.name,
          type: f.type,
          ...(f.displayName ? { display: f.displayName } : {}),
          ...(f.lookup ? { lookup: f.lookup } : {}),
          ...(f.mandatory ? { mandatory: true } : {}),
          ...(f.unique ? { unique: true } : {}),
        })),
      };
    }
    case "report": {
      const s = blockSettings(app.lines, node);
      const src = app.lines
        .slice(node.startLine, node.endLine - 1)
        .find((l) => /show all rows from/.test(l));
      return {
        ...base,
        display: s.displayName ?? s.displayname ?? null,
        reportType: node.reportType ?? null,
        baseForm: src ? src.replace(/.*show all rows from\s+/, "").trim() : null,
      };
    }
    case "page": {
      const s = blockSettings(app.lines, node);
      return { ...base, display: s.displayname ?? null };
    }
    default:
      return AUTOMATION_KINDS.has(node.kind) ? automationDetail(app, node) : base;
  }
}

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

/** Every exported app, with object counts and any parse warnings. */
export function listApps() {
  const index = getIndex();
  return {
    codebaseDir: index.dir,
    note:
      "A static mirror of the Creator source, not the live app. linkName comes from " +
      "Codebase/apps.json and is what the zoho_creator_* tools take as appLinkName; " +
      "delugeName is the same name as Deluge spells it in cross-app calls.",
    apps: index.apps.map((a) => ({
      slug: a.slug,
      application: a.name,
      linkName: a.linkName,
      delugeName: a.delugeName,
      accountOwner: a.owner,
      note: a.note,
      file: a.file,
      lines: a.lineCount,
      counts: a.counts,
      ...(a.warnings.length ? { parseWarnings: a.warnings.slice(0, 5) } : {}),
    })),
    ...(Object.keys(index.externalApps).length
      ? {
          appsCalledButNotExported: Object.entries(index.externalApps).map(([linkName, info]) => ({
            linkName,
            delugeName: delugeName(linkName),
            ...info,
          })),
        }
      : {}),
  };
}

/**
 * Names and line ranges of the objects in one or all apps.
 *
 * @param {object} opts
 * @param {string} [opts.app]     App slug, display name or link name.
 * @param {string[]} [opts.kinds] Restrict to form/report/page/function/workflow/schedule/batchworkflow/button.
 * @param {string} [opts.name]    Case-insensitive substring filter on the object name.
 * @param {boolean} [opts.detail] Include per-object metadata (form fields, triggers, signatures).
 * @param {number} [opts.limit]
 */
export function outline({ app, kinds, name, detail = false, limit } = {}) {
  const index = getIndex();
  const apps = resolveApps(index, app);
  const wanted = kinds?.length ? new Set(kinds) : PRIMARY_KINDS;
  const needle = name ? String(name).toLowerCase() : null;
  const cap = Math.min(limit ?? (detail ? 60 : 400), LIMITS.outlineObjects);

  const objects = [];
  let matched = 0;
  for (const a of apps) {
    for (const node of a.nodes) {
      if (!wanted.has(node.kind)) continue;
      if (needle && !displayName(node).toLowerCase().includes(needle)) continue;
      matched += 1;
      if (objects.length >= cap) continue;
      objects.push(detail ? objectDetail(a, node) : nodeRef(a, node));
    }
  }

  return {
    matched,
    returned: objects.length,
    truncated: matched > objects.length,
    ...(matched > objects.length
      ? { hint: "Narrow with app/kinds/name, or raise limit. Counts above are exact." }
      : {}),
    objects,
  };
}

/**
 * Full-text or regex search across the Deluge source, reporting the enclosing object
 * for every hit so a match is immediately actionable.
 */
export function searchCode({
  query,
  regex = false,
  ignoreCase = true,
  app,
  kinds,
  contextLines = 0,
  limit = 40,
} = {}) {
  if (!query || !String(query).trim()) throw new Error("query is required.");
  const index = getIndex();
  const apps = resolveApps(index, app);
  const wanted = kinds?.length ? new Set(kinds) : null;
  const cap = Math.min(limit, LIMITS.searchResults);
  const ctx = Math.min(Math.max(contextLines, 0), 10);

  let re;
  try {
    re = new RegExp(regex ? query : escapeRegExp(query), ignoreCase ? "i" : "");
  } catch (err) {
    throw new Error(`Invalid regular expression: ${err.message}`);
  }

  const matches = [];
  let total = 0;
  for (const a of apps) {
    for (let ln = 1; ln <= a.lines.length; ln += 1) {
      const raw = a.lines[ln - 1];
      if (!raw || !re.test(raw)) continue;

      const node = nodeAt(a, ln);
      const primary = node ? primaryAncestor(a, node) : null;
      if (wanted && !(primary && wanted.has(primary.kind))) continue;

      total += 1;
      if (matches.length >= cap) continue;
      matches.push({
        app: a.slug,
        line: ln,
        in: locationLabel(a, node) ?? "(top level)",
        ...(primary ? { object: nodeRef(a, primary) } : {}),
        text: trimSnippet(raw),
        ...(ctx
          ? {
              context: a.lines
                .slice(Math.max(0, ln - 1 - ctx), ln + ctx)
                .map((l, k) => `${Math.max(1, ln - ctx) + k}: ${trimSnippet(l)}`),
            }
          : {}),
      });
    }
  }

  return {
    query,
    regex,
    totalMatches: total,
    returned: matches.length,
    truncated: total > matches.length,
    ...(total > matches.length ? { hint: "Raise limit, or narrow with app/kinds." } : {}),
    matches,
  };
}

/**
 * The source of one object, or an explicit line range.
 *
 * @param {object} opts
 * @param {string} opts.app
 * @param {string} [opts.name]      Object name; `ns.fn` or plain `fn` for functions.
 * @param {string} [opts.kind]
 * @param {number} [opts.startLine] Use with endLine instead of name, e.g. to follow a search hit.
 * @param {number} [opts.endLine]
 * @param {number} [opts.maxLines]
 */
export function getSource({ app, name, kind, startLine, endLine, maxLines = 600 } = {}) {
  const index = getIndex();
  const cap = Math.min(maxLines, LIMITS.sourceLines);

  if (startLine != null) {
    const apps = resolveApps(index, app);
    if (apps.length !== 1) throw new Error("app is required when reading an explicit line range.");
    const a = apps[0];
    const from = Math.max(1, startLine);
    const to = Math.min(endLine ?? from + cap - 1, a.lines.length, from + cap - 1);
    return {
      app: a.slug,
      lines: `${from}-${to}`,
      in: locationLabel(a, nodeAt(a, from)),
      truncated: (endLine ?? to) > to,
      source: a.lines.slice(from - 1, to).join("\n"),
    };
  }

  if (!name) throw new Error("Pass either name (with optional kind/app) or startLine/endLine with app.");

  const apps = resolveApps(index, app);
  const needle = String(name).toLowerCase();
  const hits = [];
  for (const a of apps) {
    for (const node of a.nodes) {
      if (!PRIMARY_KINDS.has(node.kind)) continue;
      if (kind && node.kind !== kind) continue;
      const full = displayName(node).toLowerCase();
      if (full === needle || node.name.toLowerCase() === needle) hits.push({ a, node });
    }
  }

  if (hits.length === 0) {
    const near = suggest(index, name, kind);
    throw new Error(
      `No ${kind ?? "object"} named "${name}"` +
        (app ? ` in ${app}` : "") +
        (near.length ? `. Did you mean: ${near.join(", ")}?` : ". Try zoho_code_outline to list names.")
    );
  }
  if (hits.length > 1) {
    return {
      ambiguous: true,
      message: `"${name}" matches ${hits.length} objects. Re-run with app and/or kind to pick one.`,
      candidates: hits.map(({ a, node }) => nodeRef(a, node)),
    };
  }

  const { a, node } = hits[0];
  const to = Math.min(node.endLine, node.headerLine + cap - 1);
  return {
    ...nodeRef(a, node),
    ...(node.kind === "function" ? { signature: `${node.returnType} ${node.qualified}(${node.params})` } : {}),
    totalLines: node.endLine - node.headerLine + 1,
    returnedLines: `${node.headerLine}-${to}`,
    truncated: to < node.endLine,
    ...(to < node.endLine
      ? { hint: `Continue with app="${a.slug}", startLine=${to + 1}, endLine=${node.endLine}.` }
      : {}),
    source: a.lines.slice(node.headerLine - 1, to).join("\n"),
  };
}

function suggest(index, name, kind) {
  const needle = String(name).toLowerCase();
  const out = [];
  for (const a of index.apps) {
    for (const node of a.nodes) {
      if (!PRIMARY_KINDS.has(node.kind)) continue;
      if (kind && node.kind !== kind) continue;
      if (displayName(node).toLowerCase().includes(needle)) out.push(`${a.slug}:${displayName(node)}`);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/**
 * Every automation, with its trigger. This is the direct answer to "what runs on a
 * schedule", "what fires when a Customer is added", and "which of these is switched off".
 */
export function listAutomations({ app, kinds, includeInactive = true, target } = {}) {
  const index = getIndex();
  const apps = resolveApps(index, app);
  const wanted = kinds?.length ? new Set(kinds) : AUTOMATION_KINDS;
  const needle = target ? String(target).toLowerCase() : null;

  const items = [];
  for (const a of apps) {
    for (const node of a.nodes) {
      if (!wanted.has(node.kind)) continue;
      const detail = automationDetail(a, node);
      if (!includeInactive && detail.status !== "active") continue;
      if (needle && !(detail.target ?? "").toLowerCase().includes(needle)) continue;
      items.push(detail);
    }
  }

  const byStatus = {};
  for (const it of items) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;

  return {
    count: items.length,
    byStatus,
    note:
      "status is read from the export; automations without an explicit status line are " +
      "reported as active. target may carry the population criteria in brackets.",
    automations: items,
  };
}

/**
 * Callers and callees of a Deluge function, resolved across every exported app.
 *
 * @param {object} opts
 * @param {string} opts.name          `fn` or `namespace.fn`.
 * @param {string} [opts.app]         Disambiguate a name defined in several apps.
 * @param {"callers"|"callees"|"both"} [opts.direction]
 */
export function callGraph({ name, app, direction = "both", limit = 100 } = {}) {
  if (!name) throw new Error("name is required.");
  const index = getIndex();
  const cap = Math.min(limit, LIMITS.callSites);

  const needle = String(name).toLowerCase();

  let defs = (index.functionsByName.get(name.split(".").pop()) ?? []).filter(
    ({ node }) => displayName(node).toLowerCase() === needle || node.name.toLowerCase() === needle
  );
  if (app) {
    const only = resolveApps(index, app)[0];
    defs = defs.filter((d) => d.app === only);
  }

  if (defs.length === 0) {
    // A name that exists but is not a function - a schedule, say - is the common mistake,
    // and the useful reply is to name the thing it actually is.
    const others = [];
    for (const a of index.apps) {
      for (const node of a.nodes) {
        if (node.kind === "function" || !PRIMARY_KINDS.has(node.kind)) continue;
        if (displayName(node).toLowerCase() === needle) others.push(`${node.kind} in ${a.slug}`);
      }
    }
    if (others.length) {
      throw new Error(
        `"${name}" is not a Deluge function - it is a ${[...new Set(others)].join(", ")}. ` +
          "Call graphs cover functions only; read it with zoho_code_get_source instead."
      );
    }
    const near = suggest(index, name, "function");
    throw new Error(
      `No Deluge function named "${name}"` +
        (app ? ` in ${app}` : "") +
        (near.length ? `. Did you mean: ${near.join(", ")}?` : ".")
    );
  }

  const result = {
    function: defs.map(({ app: a, node }) => ({
      ...nodeRef(a, node),
      signature: `${node.returnType} ${node.qualified}(${node.params})`,
    })),
  };

  if (direction === "callers" || direction === "both") {
    const edges = (index.callersOf.get(defs[0].node.name) ?? []).filter((e) => {
      // A namespaced target only matches call sites that name that namespace (or none).
      const ns = defs[0].node.namespace;
      if (!ns) return true;
      const q = e.qualifier.split(".").filter(Boolean);
      return q.length === 0 || q[q.length - 1] === ns;
    });
    const callers = edges.slice(0, cap).map((e) => ({
      app: e.app.slug,
      line: e.line,
      in: locationLabel(e.app, e.node) ?? "(top level)",
      call: e.qualifier ? `${e.qualifier}.${e.callee}` : e.callee,
      // `thisapp.` or no prefix is same-app; anything else names another Creator app.
      scope: callScope(index, e),
      text: trimSnippet(e.app.lines[e.line - 1] ?? ""),
    }));
    result.callers = callers;
    result.callerCount = edges.length;
    result.callersTruncated = edges.length > callers.length;
  }

  if (direction === "callees" || direction === "both") {
    const bodies = new Set(defs.map(({ app: a, node }) => `${a.slug}#${node.index}`));
    const seen = new Map();
    for (const e of index.callEdges) {
      if (!bodies.has(`${e.app.slug}#${e.node.index}`)) continue;
      const key = `${e.qualifier}.${e.callee}`;
      if (!seen.has(key)) {
        seen.set(key, {
          call: e.qualifier ? `${e.qualifier}.${e.callee}` : e.callee,
          scope: callScope(index, e),
          firstLine: e.line,
          count: 0,
        });
      }
      seen.get(key).count += 1;
    }
    result.callees = [...seen.values()].slice(0, cap);
    result.calleeCount = seen.size;
    result.calleesTruncated = seen.size > result.callees.length;
  }

  return result;
}

/**
 * Classify a call site's prefix. A prefix that names no export is reported rather than
 * quietly resolved to the same-named export: a call into an app that is missing from the
 * mirror means the trace stops there, and that is exactly what the caller needs to know.
 */
function callScope(index, edge) {
  const parts = edge.qualifier.split(".").filter(Boolean);
  if (parts.length === 0) return "same-app";
  const head = parts[0];
  if (head === "thisapp") return "same-app";
  if (parts.length === 1) return "same-app"; // a namespace, not an app

  const target = index.byName.get(head.toLowerCase());
  if (target) return `cross-app:${target.slug}`;

  const external = index.byExternalName.get(head.toLowerCase());
  if (external) return `cross-app:${head} ("${external.application}") - NOT exported, trace stops here`;
  return `cross-app:${head} - unknown app, not exported`;
}

function trimSnippet(line) {
  const t = String(line).replace(/\s+$/, "");
  return t.length > LIMITS.snippet ? `${t.slice(0, LIMITS.snippet)} ...[truncated]` : t;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
