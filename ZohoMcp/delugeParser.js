/**
 * delugeParser.js
 *
 * Structural parser for Zoho Creator `.ds` application exports.
 *
 * A `.ds` file is one `application "Name" { ... }` block containing sections:
 *
 *   forms      { form X { <displayname>, <Field ( type = ... )>, actions { } } }
 *   reports    { default list All_X { displayName = "..", show all rows from X ( <cols> ) } }
 *   pages      { page X(params) { Content = "<zml .. escaped ..>" } }
 *   functions  { Deluge { map ns.fn(Map p) { <deluge> } } }        <- standalone functions
 *   functions  { btn as "Label" { type = functions, form = X, .. } } <- form/report buttons
 *   workflow   { form { Name as "Label" { record event = on add, on success { .. } } } }
 *   schedule   { name as "label" { type = schedule, form = X[crit], status = .., start = .. } }
 *   batchworkflow { Name { frequency = daily, batch size = 1000, status = active, .. } }
 *   web/phone/tablet { forms { form X { label placement = .. } } }  <- layout stubs, no logic
 *
 * The parser walks the file character by character, skipping strings and comments, and
 * builds a tree of blocks. Two deliberate simplifications keep it robust against the
 * arbitrary Deluge, ZML and HTML that live inside leaf bodies:
 *
 *   1. A `{` or `(` only opens a *named node* when it is the first non-whitespace
 *      character on its line. In this export format every structural block is written
 *      that way, while Deluge map literals and function-signature parens are inline.
 *   2. Function bodies, page bodies and every `( ... )` block are OPAQUE: their braces
 *      are still balanced so nesting stays correct, but no child nodes are created
 *      inside them. That stops `if (x) { ... }` in Deluge from polluting the tree.
 *
 * Nothing here is app-specific; it parses any Creator export.
 */

/** Deluge return types that can open a standalone function signature. */
const RETURN_TYPES =
  "void|map|Map|string|String|int|Int|bool|Bool|boolean|Boolean|list|List|collection|Collection|" +
  "float|Float|decimal|Decimal|date|Date|datetime|DateTime|file|File|number|Number";

const SIGNATURE_RE = new RegExp(
  `^(${RETURN_TYPES})\\s+([A-Za-z_]\\w*)(?:\\.([A-Za-z_]\\w*))?\\s*\\(([^)]*)\\)\\s*$`
);

const REPORT_RE =
  /^(?:default\s+)?(list|grid|calendar|summary|pivot|map|kanban|timeline|chart|spreadsheet)\s+([A-Za-z_]\w*)/;

/** Sections that mirror the real objects purely for per-device layout. */
const LAYOUT_SECTIONS = new Set(["web", "phone", "tablet", "mobile"]);

/** Headers of `( ... )` blocks that hold raw Deluge rather than `key = value` attributes. */
const SCRIPT_HEADER_RE =
  /^(custom deluge script|deluge script|on click|on load|on success|on add|on edit|on delete|on validate|on user input)$/i;

/**
 * Structural blocks nested inside another section, as `parentSection/header`.
 *
 * Note the export nests every automation kind under `workflow` - `schedule`,
 * `batchworkflow` and the button `functions` are siblings of `workflow/form`, not
 * top-level sections, despite being indented as though they were.
 */
const NESTED_CONTAINERS = new Set([
  "functions/Deluge",
  "workflow/form",
  "workflow/report",
  "workflow/page",
  "workflow/schedule",
  "workflow/batchworkflow",
  "workflow/functions",
]);

const MAX_HEADER_LEN = 512;

/**
 * Parse a `.ds` export into a flat, ordered list of named nodes plus a tree.
 *
 * Every node carries 1-based `headerLine` (the `form X` / signature line), `startLine`
 * (its opening brace) and `endLine` (its closing brace), so a slice of
 * `headerLine..endLine` is exactly the object's source.
 *
 * @param {string} text Full file contents.
 * @returns {{application: string|null, root: object, nodes: object[], warnings: string[]}}
 */
export function parseDs(text) {
  const warnings = [];
  const nodes = [];

  const root = {
    kind: "root",
    name: null,
    index: -1,
    parentIndex: -1,
    sectionPath: [],
    path: [],
    children: [],
    headerLine: 1,
    startLine: 1,
    endLine: 1,
  };

  /** @type {{node: object|null, opaque: boolean, isBlock: boolean}[]} */
  const stack = [];
  let currentNode = root;
  let opaqueDepth = 0;

  let line = 1;
  let curLine = "";
  let prevLine = "";
  let prevLineNo = 1;
  let lineIsBlank = true;

  const n = text.length;
  let i = 0;

  const openBlock = (delim, header, headerLine) => {
    let node = null;
    let opaque = true;
    if (opaqueDepth === 0) {
      node = makeNode(delim, header, headerLine, line, currentNode, warnings);
      if (node) {
        node.index = nodes.length;
        node.parentIndex = currentNode.index;
        nodes.push(node);
        currentNode.children.push(node);
        opaque = node.opaque;
        currentNode = node;
      }
    }
    if (opaque) opaqueDepth += 1;
    stack.push({ node, opaque, isBlock: true });
  };

  const closeBlock = (closer) => {
    const frame = stack.pop();
    if (!frame) {
      warnings.push(`line ${line}: unmatched '${closer}'`);
      return null;
    }
    if (frame.opaque) opaqueDepth -= 1;
    if (frame.node) {
      frame.node.endLine = line;
      currentNode = frame.node.parentIndex === -1 ? root : nodes[frame.node.parentIndex];
    }
    return frame;
  };

  while (i < n) {
    const c = text[i];

    if (c === "\n") {
      if (!lineIsBlank) {
        prevLine = curLine.trim();
        prevLineNo = line;
      }
      curLine = "";
      lineIsBlank = true;
      line += 1;
      i += 1;
      continue;
    }

    // Comments -------------------------------------------------------------
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl; // the newline branch above handles the line break
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k += 1) if (text[k] === "\n") line += 1;
      if (end === -1) warnings.push(`line ${line}: unterminated block comment`);
      curLine = "";
      lineIsBlank = true;
      i = stop;
      continue;
    }

    // Strings - kept verbatim so quoted display names survive into headers ---
    if (c === '"') {
      let k = i + 1;
      while (k < n) {
        if (text[k] === "\\") {
          k += 2;
          continue;
        }
        if (text[k] === '"') break;
        if (text[k] === "\n") line += 1;
        k += 1;
      }
      if (k >= n) warnings.push(`line ${line}: unterminated string`);
      if (curLine.length < MAX_HEADER_LEN) curLine += text.slice(i, Math.min(k + 1, n));
      lineIsBlank = false;
      i = k + 1;
      continue;
    }

    // Delimiters ------------------------------------------------------------
    if (c === "{" || c === "(") {
      if (lineIsBlank) {
        openBlock(c, prevLine, prevLineNo);
      } else {
        // Inline: a Deluge map literal or a function-signature paren. Balance only.
        stack.push({ node: null, opaque: true, isBlock: false });
        opaqueDepth += 1;
        if (curLine.length < MAX_HEADER_LEN) curLine += c;
      }
      lineIsBlank = false;
      i += 1;
      continue;
    }
    if (c === "}" || c === ")") {
      const frame = closeBlock(c);
      if (frame && !frame.isBlock && curLine.length < MAX_HEADER_LEN) curLine += c;
      if (frame && frame.isBlock) curLine = ""; // nothing before a closer can head a block
      lineIsBlank = false;
      i += 1;
      continue;
    }

    if (c !== " " && c !== "\t" && c !== "\r") lineIsBlank = false;
    if (curLine.length < MAX_HEADER_LEN) curLine += c;
    i += 1;
  }

  if (stack.length) {
    warnings.push(`${stack.length} block(s) left open at end of file (line ${line})`);
    while (stack.length) closeBlock("<eof>");
  }
  root.endLine = line;

  const app = root.children.find((c) => c.kind === "application") ?? null;
  return { application: app?.name ?? null, root, nodes, warnings };
}

/**
 * Classify a line-leading block from its header text and its position in the tree.
 * Returns null when the block carries no useful identity, in which case the parser
 * treats it as opaque and skips its contents.
 */
function makeNode(delim, header, headerLine, startLine, parent, warnings) {
  const parentSections = parent.sectionPath;
  const base = {
    kind: "block",
    name: header || "(anonymous)",
    display: null,
    delim,
    headerLine,
    startLine,
    endLine: startLine,
    children: [],
    index: -1,
    parentIndex: -1,
    path: parent.kind === "root" ? [] : [...parent.path, parent.name],
    sectionPath: parentSections,
    opaque: false,
  };

  if (parent.kind === "root") {
    const m = header.match(/^application\s+"(.*)"\s*$/);
    return m ? { ...base, kind: "application", name: m[1], sectionPath: [] } : null;
  }

  // Anything under a per-device layout mirror is presentation only.
  if (parentSections.length && LAYOUT_SECTIONS.has(parentSections[0])) return null;

  const isBareWord = /^[A-Za-z_]\w*$/.test(header);
  const p = parentSections;
  const section = p.length ? p[p.length - 1] : null; // section this block sits directly inside
  const outer = p.length > 1 ? p[p.length - 2] : null;

  // Containers first: `Deluge` and the automation kinds are bare words that would
  // otherwise be mistaken for objects named after their own section.
  if (delim === "{" && isBareWord) {
    const nested = section ? NESTED_CONTAINERS.has(`${section}/${header}`) : false;
    if (parent.kind === "application" || (parent.kind === "section" && nested)) {
      return {
        ...base,
        kind: "section",
        sectionPath: [...p, header],
        opaque: LAYOUT_SECTIONS.has(header),
      };
    }
  }

  if (parent.kind !== "section") {
    // Inside a form, report or automation: `actions`, `on success`, fields, script bodies.
    if (delim === "(") {
      return { ...base, kind: SCRIPT_HEADER_RE.test(header) ? "script" : "attributes", opaque: true };
    }
    return base;
  }

  if (section === "forms") {
    const m = header.match(/^form\s+([A-Za-z_]\w*)/);
    return m ? { ...base, kind: "form", name: m[1] } : null;
  }
  if (section === "reports") {
    const m = header.match(REPORT_RE);
    if (m) return { ...base, kind: "report", name: m[2], reportType: m[1] };
    const pg = header.match(/^page\s+([A-Za-z_]\w*)/);
    return pg ? { ...base, kind: "page", name: pg[1], opaque: true } : null;
  }
  if (section === "pages") {
    const m = header.match(/^page\s+([A-Za-z_]\w*)/);
    return m ? { ...base, kind: "page", name: m[1], opaque: true } : null;
  }
  if (section === "Deluge") {
    const m = header.match(SIGNATURE_RE);
    if (!m) {
      warnings.push(`line ${headerLine}: unrecognised function signature: ${header.slice(0, 120)}`);
      return null;
    }
    const [, returnType, first, second, params] = m;
    return {
      ...base,
      kind: "function",
      name: second ?? first,
      namespace: second ? first : null,
      qualified: second ? `${first}.${second}` : first,
      returnType,
      params: params.trim(),
      opaque: true,
    };
  }
  // `Name` or `Name as "Display"` - form workflows, buttons and the two schedule kinds.
  const named = header.match(/^([A-Za-z_]\w*)(?:\s+as\s+"(.*)")?\s*$/);
  if (named) {
    const kind =
      outer === "workflow" && (section === "form" || section === "report" || section === "page")
        ? "workflow"
        : section === "functions"
          ? "button"
          : section === "schedule" || section === "batchworkflow"
            ? section
            : null;
    if (kind) return { ...base, kind, name: named[1], display: named[2] ?? null };
  }

  return base;
}

/**
 * `key = value` settings from a block's own header region - the lines between its
 * opening brace and its first nested block. Restricting the scan that way keeps
 * `form = Customer` (the trigger) separate from `form` mentions in the Deluge below.
 *
 * @param {string[]} lines Whole file split on newlines (0-based).
 */
export function blockSettings(lines, node) {
  const firstChild = node.children[0];
  const lastLine = firstChild ? firstChild.headerLine - 1 : node.endLine - 1; // 1-based, inclusive
  return scanSettings(lines, node.startLine + 1, lastLine);
}

/** `key = value` pairs across the whole of a `( ... )` attribute block. */
function attributeSettings(lines, node) {
  return scanSettings(lines, node.startLine + 1, node.endLine - 1);
}

function scanSettings(lines, fromLine, toLine) {
  const out = {};
  for (let ln = fromLine; ln <= toLine; ln += 1) {
    const raw = lines[ln - 1];
    if (raw === undefined) break;
    const m = raw.match(/^\s*([A-Za-z][A-Za-z ]*?)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].trim();
    if (out[key] === undefined) out[key] = stripQuotes(m[2]);
  }
  return out;
}

function stripQuotes(v) {
  const t = v.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * Field definitions on a form: the `Name ( type = ... )` blocks directly beneath it.
 *
 * Creator writes constraints as prefixes on the field name - `must have Customer`,
 * `unique Email`, `must have unique Phone_Number` - so the prefix is stripped back off
 * and reported as flags. Blocks with no `type`, and `type = section` layout dividers,
 * are not fields and are skipped.
 */
export function formFields(lines, formNode) {
  const fields = [];
  for (const child of formNode.children) {
    if (child.kind !== "attributes") continue;
    const s = attributeSettings(lines, child);
    if (!s.type || s.type === "section") continue;

    const m = child.name.match(/^(must have\s+unique|must have|unique)\s+([A-Za-z_]\w*)$/);
    const name = m ? m[2] : child.name;
    const prefix = m ? m[1] : "";

    fields.push({
      name,
      type: s.type,
      displayName: s.displayname ?? null,
      // Lookup source, e.g. `Transaction.ID`, or `other_app.Market.ID` when cross-app.
      lookup: s.values ?? null,
      mandatory: prefix.startsWith("must have") || s.mandatory === "true",
      unique: prefix.endsWith("unique"),
      line: child.headerLine,
    });
  }
  return fields;
}
