# Deluge source — Peets Coffee Rewards (`test-peets-new`)

Exported Zoho Creator source for review, documentation, and debugging.
This folder holds **code only**. Live data comes from the `peetsmcp` MCP server.

## What this app is

Zoho Creator loyalty/rewards app. Account owner `rtbidigitalassets_americanafood`,
app link name `test-peets-new` (display name "Peets Coffee Rewards").
62 forms, 75 reports. Holds **real production customer and transaction data.**

## Layout

```
functions/    standalone Deluge functions (Workflow → Functions), one file each
forms/        per-form workflow scripts (On Add / On Edit / On Validate / field events)
schedules/    scheduled workflows — script plus its trigger frequency
```

If the whole app was exported as a single `.ds` file, drop it in at the top level
as `app-export.ds` and ignore the subfolders — it contains everything.

Name files after the Creator link name, e.g. `functions/grant_signup_bonus.dg`.
Deluge has no standard extension; `.dg` or `.txt` both read fine.

## Reading Deluge

Not JavaScript, despite the surface resemblance:

- `for each` iteration, `info` for logging
- Collections are `Map` / `List`; `Collection()` builds them
- Record access: `Form_Name[criteria]`, `insert into Form_Name`, `.update()`
- `thisapp.functionName()` calls another standalone function
- Standalone functions are only reachable over REST if published as a **Custom API**
- Schedules and form workflows run server-side, invisible to the API

## Known open issue

Sign-up bonus appears to **re-fire**, granting bonus points more than once per
customer. Suspected causes, in order:

1. A schedule re-running over customers whose flag was never set
2. An On Edit workflow on `Customer` re-triggering when a points field changes
3. Eligibility checked against a value the grant itself mutates

When tracing it, the question to answer is: **what makes the grant idempotent?**
If nothing does, that is the bug. Look for a guard flag being written in the same
transaction as the points award, and whether the eligibility read happens before
or after that write.

Relevant forms: `Bonus_Points`, `Joining_Rules`, `Customer_Points_System`,
`Customer`, `Membership_Points_System`, `Earning_Points`.

## Pairing with live data

The `peetsmcp` MCP server (in `../PEETSMCP/`) reads the live app: records, form
field schemas, forms/reports listings. Source explains *intent*; MCP shows what
*actually happened*. Use both — "this function assumes `Membership_Tier` is never
null" is a claim only live data can confirm.

Its `zoho_creator_call_function` **executes** a published function. Never call it
to "test" anything that writes points, grants rewards, or touches transactions —
it hits production.

## Ground rules

- **Read-only unless asked.** The credentials carry delete scope over real
  customer records. Propose changes as diffs; do not apply them to Creator.
- Deluge changes are made in the Creator builder UI, not by editing these files.
  Treat this folder as a mirror, and say so when suggesting an edit.
- Do not invent Creator API endpoints. There is no REST access to Deluge source,
  functions, workflows, or schedules — that is why this folder exists.
