# Running the daily report from a second PC

The daily health report normally runs on one PC (Deepak's) at 6 AM India time. This guide sets
up a second person as a backup. They run the same steps when that PC is off, and the results go
to the same dashboard: https://claude.ai/artifact/3fCTyTgKjEGYWwB6LVus2z

Only one PC should run the report on a given day. Running it twice doesn't break anything (the
second run overwrites the same days with the same figures), but it doubles the Zoho calls.

## What you need

1. **Claude desktop app**, signed in with your Americana account.
2. **The MCPZOHO project**, up to date: `git pull` in the MCPZOHO folder.
3. **The ZohoMcp connector** in your Claude app, with your own Zoho API credentials.
4. **Edit access to the dashboard.** Ask Deepak to add you as an editor from the dashboard's
   Share menu. Editors can save report data; view-only people can't.

## One-time setup

### 1. Copy the report history (recommended)

Ask Deepak for a copy of the `%LOCALAPPDATA%\peets-daily-report` folder from Deepak's PC. Put it at the same place
on your PC: paste `%LOCALAPPDATA%` into File Explorer's address bar to find it.

It holds each store's recent daily sales, which the "far below its usual day" check compares
against, plus the list of days already published. Without it the report still works, but the
store checks need a few weeks to learn each store's normal day again.

The folder has customer names and masked phone numbers from the reports, so keep it on your PC.

### 2. Create the task in Claude

In the Claude app, open **Scheduled** in the sidebar and create a new task named
`peets-daily-health-report`. Leave it **without a schedule** so it only runs when you click
**Run now**. Use the prompt below. If your MCPZOHO folder isn't at the path shown, change the
BUILDER line.

```
Build the missing Peet's Rewards daily health reports from Zoho Creator and publish them to the "Rewards Daily Health" dashboard.

Dashboard (a Claude artifact): https://claude.ai/artifact/3fCTyTgKjEGYWwB6LVus2z
Its database has two collections, "summaries" and "days", with one document per Dubai day (doc id YYYY-MM-DD).
BUILDER means: node "%USERPROFILE%\OneDrive - Kuwait Food Company\Desktop\Codes\AmericanaProjects\MCPZOHO\daily-report\daily-report.mjs"
Run BUILDER commands with PowerShell (so %USERPROFILE% expands, write it as $env:USERPROFILE there) or with the full path.

Rules:
- Zoho is read-only for this task. The only Zoho tool you may call is mcp__ZohoMcp__zoho_creator_get_all_records. Never call zoho_creator_add_record, zoho_creator_update_record, zoho_creator_delete_record or zoho_creator_call_function.
- Don't edit the builder, the dashboard page or any other file, and don't republish the artifact. Only write its database, with the ArtifactData tool.
- If mcp__ZohoMcp__zoho_creator_get_all_records or ArtifactData isn't loaded yet, load it with ToolSearch first.

Steps:
1. Run: BUILDER plan
   It prints JSON with "days" and "calls". If "days" is empty, reply "Nothing to build: the last three days are already on the dashboard." and stop.
2. For every entry in "calls", call mcp__ZohoMcp__zoho_creator_get_all_records with exactly that entry's "args". Don't change, drop or add arguments. You may run up to 6 at once. Each result should show "count" and "savedTo".
   - If a result contains "records" instead of "savedTo", the connector is an older version without saveAs. Stop and report that the ZohoMcp folder needs a git pull and Claude has to be restarted.
   - If a call fails, retry it once. If it fails again, carry on and note which calls failed.
3. Run: BUILDER build
   If it reports missing files, run it again adding --in "<folder>" with the folder shown in the savedTo paths.
4. For each built day, write both files with one ArtifactData call: action "batch", url https://claude.ai/artifact/3fCTyTgKjEGYWwB6LVus2z, writes = [{"op":"set","collection":"summaries","doc_id":"<date>","file_path":"<summaryFile>"}, {"op":"set","collection":"days","doc_id":"<date>","file_path":"<dayFile>"}].
   If the batch is refused because a document already exists, read each of the two documents with ArtifactData action "get" and out_dir set to the dbcheck folder inside %LOCALAPPDATA%\peets-daily-report (so their content stays out of the conversation), then retry the batch with each document's version as that entry's if_version.
5. After a day's batch succeeds, run: BUILDER mark --date <date>
6. Reply with a short summary: for each published day its date, status, sales count and top three flags, then the dashboard link. List any failed calls or skipped days.
```

The first run asks you to approve the Zoho and ArtifactData tools. Approve them, and later runs
won't ask again.

## When to run it

Click **Run now** on any morning when Deepak's PC was off at 6 AM. Each run catches up on any of
the last three days that weren't published: Zoho deletes its till and NCR logs after 3 days, so
a day missed for longer can only be rebuilt from transactions.

When Deepak's PC is back on, its own 6 AM run won't know you published those days and will
rebuild them once more. That's harmless: same figures, same dashboard.

## The weekly brand email

The Monday brand summary is built from the daily summaries on the PC that runs it, and saved as a
draft in that person's Outlook. Keep it on Deepak's PC. If you ever need to make it from yours,
run `BUILDER weekly` and copy the HTML file it names into a new email. Your copied history folder
needs the whole week for the figures to be complete.
