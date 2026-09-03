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
 * Configuration is entirely environment-driven; see .env.example and README.md.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadEnvFiles } from "./loadEnv.js";
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

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `Zoho Creator request failed: ${message}` }],
  };
}

/** Wrap a tool handler so any throw becomes an isError result instead of a crash. */
function safeHandler(fn) {
  return async (args) => {
    try {
      return jsonResult(await fn(args));
    } catch (err) {
      return errorResult(err);
    }
  };
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
      "reached before the data ran out, meaning the count is a floor, not a total.",
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
    },
  },
  safeHandler(async ({ appLinkName, reportLinkName, criteria, fields, maxPages }) => {
    const { records, pages, complete } = await getAllRecords({
      appLinkName,
      reportLinkName,
      criteria,
      fields,
      maxPages,
    });
    return { count: records.length, pages, complete, records };
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
