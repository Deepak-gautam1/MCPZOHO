#!/usr/bin/env node
/**
 * server.js
 *
 * MCP server exposing Zoho Creator to Claude over stdio.
 *
 * Tools:
 *   zoho_creator_list_applications - discover apps on the account
 *   zoho_creator_list_forms      - discover forms in an app
 *   zoho_creator_list_reports    - discover reports (views) in an app
 *   zoho_creator_list_fields     - inspect a form's field schema
 *   zoho_creator_get_records     - read one page of records from a report
 *   zoho_creator_get_all_records - page through every matching record
 *   zoho_creator_add_record      - create a record through a form
 *   zoho_creator_update_record   - update a record by id
 *   zoho_creator_delete_record   - delete a record by id
 *   zoho_creator_call_function   - invoke a Deluge function published as a Custom API
 *
 * Source tools, reading the .ds exports in ./Codebase (no network, no credentials):
 *   zoho_code_list_apps          - which apps are mirrored, and their object counts
 *   zoho_code_outline            - names, line ranges and schemas of an app's objects
 *   zoho_code_search             - search the Deluge, attributed to the enclosing object
 *   zoho_code_get_source         - the source of one object, or a line range
 *   zoho_code_list_automations   - workflows, schedules, batch jobs and their triggers
 *   zoho_code_call_graph         - callers and callees of a Deluge function, cross-app
 *
 * Configuration is entirely environment-driven; see .env.example and README.md.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadEnvFiles } from "./loadEnv.js";
import {
  callGraph,
  getSource,
  listApps,
  listAutomations,
  outline,
  searchCode,
} from "./codebase.js";
import {
  addRecord,
  callCustomFunction,
  deleteRecord,
  getRecords,
  getAllRecords,
  listApplications,
  listFields,
  listForms,
  listReports,
  updateRecord,
} from "./zohoClient.js";

// Populate process.env from .env.local/.env for local development. Real
// environment variables (e.g. Claude Desktop's env block) always take priority.
//
// ES module imports are hoisted, so this runs after zohoClient.js is evaluated -
// which is fine, and must stay fine: zohoClient reads its configuration lazily
// inside each function, never at module top level. Keep it that way.
loadEnvFiles();

const server = new McpServer({
  name: "peetsmcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Shared schema fragments and result helpers
// ---------------------------------------------------------------------------

const appLinkNameSchema = z
  .string()
  .optional()
  .describe(
    "Zoho Creator application link name. Optional - falls back to the ZOHO_APP_LINK_NAME " +
      "environment variable. Only pass this when targeting a different app than the default."
  );

/** Where zoho_creator_get_all_records writes saveAs files. Read at call time, like the rest of the config. */
function exportDir() {
  return process.env.ZOHO_EXPORT_DIR || join(tmpdir(), "zoho-mcp-exports");
}

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(err, prefix) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `${prefix}: ${message}` }],
  };
}

/** Wrap a tool handler so any throw becomes an isError result instead of a crash. */
function safeHandler(fn, prefix = "Zoho Creator request failed") {
  return async (args) => {
    try {
      return jsonResult(await fn(args));
    } catch (err) {
      return errorResult(err, prefix);
    }
  };
}

/** Source-tool handler: failures are local (missing or unparsable exports), not API errors. */
function sourceHandler(fn) {
  return safeHandler(fn, "Creator source lookup failed");
}

// ---------------------------------------------------------------------------
// Discovery tools
// ---------------------------------------------------------------------------

server.registerTool(
  "zoho_creator_list_applications",
  {
    title: "List Zoho Creator applications",
    description:
      "List every Zoho Creator application the connected account can access, with each app's " +
      "link name and owner (workspace) name. This is account-level and needs no app context, " +
      "so it is the right first call when the app link name or account owner is unknown - the " +
      "link_name it returns is exactly what the other tools expect as appLinkName.",
    inputSchema: {},
  },
  safeHandler(() => listApplications())
);

server.registerTool(
  "zoho_creator_list_forms",
  {
    title: "List Zoho Creator forms",
    description:
      "List every form in a Zoho Creator application, with its display name and link name. " +
      "Use this first when you do not know the exact form link name needed by " +
      "zoho_creator_add_record - Creator APIs require link names, not display names.",
    inputSchema: {
      appLinkName: appLinkNameSchema,
    },
  },
  safeHandler(({ appLinkName }) => listForms({ appLinkName }))
);

server.registerTool(
  "zoho_creator_list_reports",
  {
    title: "List Zoho Creator reports",
    description:
      "List every report (view) in a Zoho Creator application, with its display name and link name. " +
      "Use this first when you do not know the exact report link name needed by " +
      "zoho_creator_get_records, zoho_creator_update_record, or zoho_creator_delete_record. " +
      "Records are always read and modified through a report, never through a form.",
    inputSchema: {
      appLinkName: appLinkNameSchema,
    },
  },
  safeHandler(({ appLinkName }) => listReports({ appLinkName }))
);

server.registerTool(
  "zoho_creator_list_fields",
  {
    title: "List Zoho Creator form fields",
    description:
      "List the fields on a form, with each field's link name, display name, numeric type code, " +
      "mandatory flag, and whether it is a lookup into another form. Call this before " +
      "zoho_creator_add_record or zoho_creator_update_record so the data keys are real field " +
      "link names rather than guesses - display names and link names often differ, and a wrong " +
      "key is silently ignored by Zoho instead of raising an error. Fields are defined on forms, " +
      "so to learn the columns behind a report, inspect the form that feeds it.",
    inputSchema: {
      appLinkName: appLinkNameSchema,
      formLinkName: z
        .string()
        .describe(
          "Link name of the form whose fields to list, e.g. Customer. Get it from " +
            "zoho_creator_list_forms."
        ),
    },
  },
  safeHandler(({ appLinkName, formLinkName }) => listFields({ appLinkName, formLinkName }))
);

// ---------------------------------------------------------------------------
// Record CRUD tools
// ---------------------------------------------------------------------------

server.registerTool(
  "zoho_creator_get_records",
  {
    title: "Get Zoho Creator records",
    description:
      "Read records from a Zoho Creator report. This is plain data retrieval - use it to look " +
      "up, filter, list, or count rows. Supports a Deluge-style criteria filter, field selection, " +
      "and paging. Use zoho_creator_list_reports first if the report link name is unknown. " +
      "For business logic that goes beyond reading rows (PDF generation, approvals, multi-step " +
      "processing), use zoho_creator_call_function instead.",
    inputSchema: {
      appLinkName: appLinkNameSchema,
      reportLinkName: z
        .string()
        .describe("Link name of the report to read from, e.g. All_Orders."),
      criteria: z
        .string()
        .optional()
        .describe(
          'Deluge-style filter expression, e.g. Status == "Open" or ' +
            '(Amount > 100 && Country == "Kuwait"). Omit to return all records. ' +
            "Field link names are case sensitive."
        ),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          "Field link names to return, e.g. [\"Customer_Name\", \"Amount\"]. " +
            "Omit to let Zoho return the report's default field set."
        ),
      maxRecords: z
        .union([z.literal(200), z.literal(500), z.literal(1000)])
        .optional()
        .describe(
          "Page size. Zoho accepts ONLY 200, 500 or 1000 and rejects anything else " +
            "(error 9250). Defaults to 200."
        ),
      recordCursor: z
        .string()
        .optional()
        .describe(
          "Cursor for the next page, taken from the record_cursor field of the previous " +
            "response. Omit for the first page; stop when record_cursor comes back null. " +
            "Creator has no offset paging - there is no page number."
        ),
    },
  },
  safeHandler(({ appLinkName, reportLinkName, criteria, fields, maxRecords, recordCursor }) =>
    getRecords({ appLinkName, reportLinkName, criteria, fields, maxRecords, recordCursor })
  )
);

server.registerTool(
  "zoho_creator_get_all_records",
  {
    title: "Get every matching Zoho Creator record",
    description:
      "Read ALL records matching a criteria by paging through the report automatically, and " +
      "return them together with an exact count. Use this instead of zoho_creator_get_records " +
      "whenever the question is 'how many' or 'all of them' - a single get_records call sees " +
      "at most 1000 rows, and Creator has no offset paging, so a partial read silently looks " +
      "like a complete one. Narrow with criteria and fields first: every page is a separate " +
      "API call against a rate limit. The result reports complete:false if the page cap was " +
      "reached before the data ran out, meaning the count is a floor, not a total. A criteria " +
      "that matches nothing returns count 0. For a large read that a script will process, pass " +
      "saveAs to write the records to a file instead of returning them.",
    inputSchema: {
      appLinkName: appLinkNameSchema,
      reportLinkName: z.string().describe("Link name of the report to read from."),
      criteria: z
        .string()
        .optional()
        .describe('Deluge-style filter, e.g. Bonus_Type == "Sign Up". Strongly recommended.'),
      fields: z
        .array(z.string())
        .optional()
        .describe("Field link names to return. Narrow this - it materially reduces payload size."),
      maxPages: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Safety cap on pages fetched at 1000 rows each. Default 50 (50,000 rows)."),
      saveAs: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.json$/)
        .optional()
        .describe(
          "File name (letters, digits, . _ -, ending in .json) to write the full result to, in " +
            "the export folder (ZOHO_EXPORT_DIR, default <system temp>/zoho-mcp-exports). The " +
            "tool then returns the count and the file path instead of the records. An existing " +
            "file with that name is replaced."
        ),
    },
  },
  safeHandler(async ({ appLinkName, reportLinkName, criteria, fields, maxPages, saveAs }) => {
    const { records, pages, complete } = await getAllRecords({
      appLinkName,
      reportLinkName,
      criteria,
      fields,
      maxPages,
    });
    const result = { count: records.length, pages, complete, records };
    if (!saveAs) return result;

    const dir = exportDir();
    mkdirSync(dir, { recursive: true });
    const savedTo = join(dir, saveAs);
    const text = JSON.stringify(result);
    writeFileSync(savedTo, text);
    return { count: records.length, pages, complete, savedTo, bytes: Buffer.byteLength(text) };
  })
);

server.registerTool(
  "zoho_creator_add_record",
  {
    title: "Add a Zoho Creator record",
    description:
      "Create a single new record by submitting a Zoho Creator form. Use this for a plain insert " +
      "of field values. The data keys must be field link names as defined on the form - call " +
      "zoho_creator_list_forms if you are unsure of the form link name. Any Deluge workflow the " +
      "form itself has 'on create' will still run. If the record needs business logic that the " +
      "form does not implement, call zoho_creator_call_function instead.",
    inputSchema: {
      appLinkName: appLinkNameSchema,
      formLinkName: z
        .string()
        .describe("Link name of the form to submit to, e.g. Order_Entry."),
      data: z
        .record(z.any())
        .describe(
          "Field values keyed by field link name, e.g. " +
            '{ "Customer_Name": "Acme", "Amount": 250, "Order_Date": "27-Aug-2026" }. ' +
            "Dates use the format configured on the form; subforms are arrays of objects."
        ),
    },
  },
  safeHandler(({ appLinkName, formLinkName, data }) =>
    addRecord({ appLinkName, formLinkName, data })
  )
);

server.registerTool(
  "zoho_creator_update_record",
  {
    title: "Update a Zoho Creator record",
    description:
      "Update a single existing record, identified by its record id, through a report. Only the " +
      "fields present in data are changed; everything else is left alone. Get the record id from " +
      "zoho_creator_get_records first (Zoho returns it as the ID field). Use this for a plain " +
      "field edit; for logic-driven updates use zoho_creator_call_function.",
    inputSchema: {
      appLinkName: appLinkNameSchema,
      reportLinkName: z
        .string()
        .describe("Link name of the report the record is visible in, e.g. All_Orders."),
      recordId: z
        .string()
        .describe("Zoho record id (the ID field returned by zoho_creator_get_records)."),
      data: z
        .record(z.any())
        .describe(
          'Fields to change, keyed by field link name, e.g. { "Status": "Shipped" }. ' +
            "Fields left out of this object are not modified."
        ),
    },
  },
  safeHandler(({ appLinkName, reportLinkName, recordId, data }) =>
    updateRecord({ appLinkName, reportLinkName, recordId, data })
  )
);

server.registerTool(
  "zoho_creator_delete_record",
  {
    title: "Delete a Zoho Creator record",
    description:
      "Permanently delete a single record by its record id, through a report. This cannot be " +
      "undone - confirm the record identity with zoho_creator_get_records before calling, and " +
      "make sure the user actually asked for a deletion.",
    inputSchema: {
      appLinkName: appLinkNameSchema,
      reportLinkName: z
        .string()
        .describe("Link name of the report the record is visible in, e.g. All_Orders."),
      recordId: z
        .string()
        .describe("Zoho record id (the ID field returned by zoho_creator_get_records)."),
    },
  },
  safeHandler(({ appLinkName, reportLinkName, recordId }) =>
    deleteRecord({ appLinkName, reportLinkName, recordId })
  )
);

// ---------------------------------------------------------------------------
// Custom Deluge function
// ---------------------------------------------------------------------------

server.registerTool(
  "zoho_creator_call_function",
  {
    title: "Call a Zoho Creator custom function",
    description:
      "Invoke a standalone Deluge function that has been published as a Custom API in Zoho " +
      "Creator. This is the tool for real business logic that lives in the Creator app - PDF or " +
      "invoice generation, approval and notification workflows, batch or multi-step processing, " +
      "integrations with other systems, and any computation that is not a plain row read or " +
      "write. Prefer it over the CRUD tools whenever the app already implements the operation: " +
      "the function enforces the app's own validation and side effects, which raw record writes " +
      "bypass. The apiLinkName, the HTTP method, and the argument names must match how the " +
      "function was published in Creator (Settings > Custom API).",
    inputSchema: {
      appLinkName: appLinkNameSchema,
      apiLinkName: z
        .string()
        .describe(
          "Link name of the published Custom API, e.g. generate_invoice_pdf. This is the name " +
            "shown in the Creator Custom API settings, not the Deluge function's display name."
        ),
      method: z
        .enum(["GET", "POST"])
        .optional()
        .default("POST")
        .describe(
          "HTTP method the Custom API was published with. Must match Creator's configuration; " +
            "POST is the usual choice for functions that take arguments or cause side effects."
        ),
      params: z
        .record(z.any())
        .optional()
        .describe(
          "Arguments passed as query-string parameters, keyed by the Deluge function's parameter " +
            'names, e.g. { "orderId": "4567" }. Works with both GET and POST.'
        ),
      body: z
        .record(z.any())
        .optional()
        .describe(
          "JSON request body, for POST only. Use this when the function expects a structured " +
            "payload rather than simple scalar arguments."
        ),
    },
  },
  safeHandler(({ appLinkName, apiLinkName, method, params, body }) =>
    callCustomFunction({ appLinkName, apiLinkName, method, params, body })
  )
);

// ---------------------------------------------------------------------------
// Source tools - the Deluge codebase mirror in ./Codebase
//
// The zoho_creator_* tools above answer "what data is in the app right now".
// These answer "what does the app DO" - the rules, workflows, schedules and call
// graph that produced that data. They read the .ds exports on disk, so they need
// no credentials, cost no API quota, and see logic that is invisible to the REST
// API (form workflows, schedules, commented-out code, every private function).
// ---------------------------------------------------------------------------

const codeAppSchema = z
  .string()
  .optional()
  .describe(
    "Which exported app to look in - its slug (Peets_Coffee_Rewards), display name " +
      "(Peets Coffee Rewards) or Creator link name (test_peets_new) all work. " +
      "Omit to search every app at once, which is usually right when tracing cross-app behaviour."
  );

const codeKindsSchema = z
  .array(z.enum(["form", "report", "page", "function", "workflow", "schedule", "batchworkflow", "button"]))
  .optional();

server.registerTool(
  "zoho_code_list_apps",
  {
    title: "List mirrored Creator apps",
    description:
      "List the Zoho Creator apps whose Deluge source has been exported into the local " +
      "Codebase folder, with each app's link name and a count of its forms, reports, pages, " +
      "functions, workflows and schedules. Start here for any question about how the apps " +
      "work: it shows what source is available and gives the link names the live " +
      "zoho_creator_* tools need. Note this is a point-in-time export, not the live app - " +
      "if a question turns on current data, read it with the zoho_creator_* tools instead.",
    inputSchema: {},
  },
  sourceHandler(() => listApps())
);

server.registerTool(
  "zoho_code_outline",
  {
    title: "Outline a Creator app's objects",
    description:
      "List the objects defined in the exported source - forms, reports, pages, Deluge " +
      "functions, workflows, schedules and buttons - with the line range of each. Use it to " +
      "find the real name of something before fetching it, or to survey an area ('every " +
      "function in the loyaltyEngine namespace'). With detail=true it also returns each " +
      "object's specifics: a form's full field list with types, lookups and mandatory flags; " +
      "a function's signature; a report's base form. detail=true on a form is the fastest way " +
      "to learn a schema, and unlike zoho_creator_list_fields it costs no API call.",
    inputSchema: {
      app: codeAppSchema,
      kinds: codeKindsSchema.describe(
        "Restrict to these object kinds. Omit for all of them."
      ),
      name: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring of the object name, e.g. 'Customer' or 'loyaltyEngine.'. " +
            "Functions match on namespace.name."
        ),
      detail: z
        .boolean()
        .optional()
        .describe(
          "Include per-object metadata (form fields, function signatures, automation triggers). " +
            "Much larger output, so pair it with app/kinds/name. Default false."
        ),
      limit: z.number().int().min(1).max(2000).optional().describe("Max objects returned."),
    },
  },
  sourceHandler(({ app, kinds, name, detail, limit }) => outline({ app, kinds, name, detail, limit }))
);

server.registerTool(
  "zoho_code_search",
  {
    title: "Search the Deluge source",
    description:
      "Search the exported Deluge line by line and report, for every hit, the object that " +
      "contains it - 'function loyaltyEngine.creditbonuspoint_V2' or 'batchworkflow " +
      "Validate_User_Tier_Status > on execute > custom deluge script'. That attribution is the " +
      "point: a raw grep tells you a string exists, this tells you which rule it belongs to. " +
      "Use it to find where a field is written, where a hardcoded value or API key appears, or " +
      "which code touches a form. Searches commented-out code too, which often explains why " +
      "something no longer happens.",
    inputSchema: {
      query: z.string().describe("Text to find, or a JavaScript regular expression if regex is true."),
      regex: z
        .boolean()
        .optional()
        .describe("Treat query as a regular expression. Default false (literal substring)."),
      ignoreCase: z.boolean().optional().describe("Case-insensitive. Default true."),
      app: codeAppSchema,
      kinds: codeKindsSchema.describe(
        "Only report hits inside these kinds of object, e.g. [\"schedule\",\"batchworkflow\"] " +
          "to see only what the scheduled jobs do."
      ),
      contextLines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Lines of surrounding source to include with each hit. Default 0."),
      limit: z.number().int().min(1).max(200).optional().describe("Max hits returned. Default 40."),
    },
  },
  sourceHandler(({ query, regex, ignoreCase, app, kinds, contextLines, limit }) =>
    searchCode({ query, regex, ignoreCase, app, kinds, contextLines, limit })
  )
);

server.registerTool(
  "zoho_code_get_source",
  {
    title: "Read Creator source",
    description:
      "Return the exact source of one object - a Deluge function, a form, a workflow, a " +
      "schedule - or an explicit line range. Pass name (with kind and app to disambiguate), " +
      "or app plus startLine/endLine to follow up a zoho_code_search hit. Long objects come " +
      "back truncated with the line numbers needed to fetch the rest. Read the source before " +
      "describing what a rule does; the export is the authority on behaviour, and summaries " +
      "of it go stale.",
    inputSchema: {
      app: codeAppSchema,
      name: z
        .string()
        .optional()
        .describe(
          "Object name. Functions accept either namespace.name (loyaltyEngine.creditbonuspoint) " +
            "or the bare name. Omit when reading a line range."
        ),
      kind: z
        .enum(["form", "report", "page", "function", "workflow", "schedule", "batchworkflow", "button"])
        .optional()
        .describe("Disambiguate when a function and an automation share a name."),
      startLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Read this line range instead of a named object. Requires app."),
      endLine: z.number().int().min(1).optional().describe("Last line of the range, inclusive."),
      maxLines: z
        .number()
        .int()
        .min(1)
        .max(3000)
        .optional()
        .describe("Cap on lines returned. Default 600."),
    },
  },
  sourceHandler(({ app, name, kind, startLine, endLine, maxLines }) =>
    getSource({ app, name, kind, startLine, endLine, maxLines })
  )
);

server.registerTool(
  "zoho_code_list_automations",
  {
    title: "List Creator automations and their triggers",
    description:
      "List everything that runs on its own - form workflows (on add/edit/delete), scheduled " +
      "jobs, batch workflows and action buttons - with the trigger for each: the form and " +
      "criteria it targets, the record event or schedule frequency, the batch size, and " +
      "whether it is active or inactive. This is the tool for 'what runs nightly', 'what " +
      "happens when a Customer is added', and 'which of these is switched off'. None of this " +
      "is visible through the Creator REST API, so it cannot be answered any other way. " +
      "Follow up with zoho_code_get_source to read a specific job's body.",
    inputSchema: {
      app: codeAppSchema,
      kinds: z
        .array(z.enum(["workflow", "schedule", "batchworkflow", "button"]))
        .optional()
        .describe("Restrict to these automation kinds. Omit for all of them."),
      includeInactive: z
        .boolean()
        .optional()
        .describe(
          "Include automations marked inactive. Default true - a disabled job usually explains " +
            "why something stopped happening, so it is worth seeing."
        ),
      target: z
        .string()
        .optional()
        .describe(
          "Only automations whose target form matches this substring, e.g. 'Customer_Points_System'."
        ),
    },
  },
  sourceHandler(({ app, kinds, includeInactive, target }) =>
    listAutomations({ app, kinds, includeInactive, target })
  )
);

server.registerTool(
  "zoho_code_call_graph",
  {
    title: "Trace a Deluge function's callers and callees",
    description:
      "Find every place a Deluge function is called from, and everything it calls, across all " +
      "exported apps at once. Each call site is labelled same-app or cross-app, and a cross-app " +
      "call naming an app that is not in the export set is reported as such rather than " +
      "silently dropped. Use it before judging whether a function is dead, before changing one " +
      "(to see what depends on it), and to trace a request from the mobile API gateway down to " +
      "the rule that handles it. Call sites are matched against functions that actually exist " +
      "in the source, so built-ins like zoho.crm.getRecords are not reported as calls.",
    inputSchema: {
      name: z
        .string()
        .describe(
          "Function name, as namespace.name (loyaltyEngine.executeLoyaltyProgramme) or bare " +
            "(executeLoyaltyProgramme). A bare name matches the function in every app that defines it."
        ),
      app: codeAppSchema,
      direction: z
        .enum(["callers", "callees", "both"])
        .optional()
        .describe("Default both. 'callers' answers who depends on this; 'callees' what it depends on."),
      limit: z.number().int().min(1).max(300).optional().describe("Max call sites returned. Default 100."),
    },
  },
  sourceHandler(({ name, app, direction, limit }) => callGraph({ name, app, direction, limit }))
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel - all diagnostics must go to stderr.
  console.error("peetsmcp: Zoho Creator MCP server running on stdio");
}

main().catch((err) => {
  console.error("peetsmcp: fatal error starting server:", err);
  process.exit(1);
});
