# Rewards Daily Health

A daily health report for the Peet's Coffee Rewards app (Zoho Creator, `test-peets-new`),
published to the **Rewards Daily Health** dashboard:
https://claude.ai/artifact/3fCTyTgKjEGYWwB6LVus2z

A Claude scheduled task (`peets-daily-health-report`, 6:00 AM India time) runs the steps below.
Everything it reads from Zoho is read-only.

## How a run works

1. `node daily-report.mjs plan` picks the days to build: yesterday (Dubai time), plus either
   of the two days before it that was never published. Creator deletes API and NCR logs
   after 3 days, so a missed morning is caught up while the logs still exist. It prints the
   `zoho_creator_get_all_records` calls to make, each with a `saveAs` file name.
2. The task makes those calls through the ZohoMcp connector. `saveAs` writes each result to
   `ZOHO_EXPORT_DIR` (default `%TEMP%\zoho-mcp-exports`) instead of returning the rows.
3. `node daily-report.mjs build` reads the files and writes `summary-<date>.json` (small,
   for the month view) and `day-<date>.json` (the detail) to `%LOCALAPPDATA%\peets-daily-report`,
   which also holds `state.json`, the list of published days.
4. The task writes both files to the dashboard database (`summaries/<date>`, `days/<date>`)
   and runs `node daily-report.mjs mark --date <date>`.

`node daily-report.mjs history --from 2026-09-01 --to 2026-09-26 --tx <export> [--signups <export>] [--stores <export>]`
builds transaction-only reports for days whose logs are gone.

## Weekly brand summary

A second scheduled task (`peets-weekly-brand-summary`, Mondays 9:00 AM India time) runs
`node daily-report.mjs weekly`. That writes `weekly-<monday>.html`: a plain business summary of the
last Monday–Sunday week, built from the daily summaries, with a week-on-week comparison. The task
saves it as an **Outlook draft** to the brand team and never sends it; someone reviews and sends
it. Outlook drafts made through the connector accept only plain HTML (no style attributes), so the
tables are unstyled. `--end YYYY-MM-DD` builds the week ending on that Sunday.

## Store master

`store-master.json` is the company store list, taken from the "For Loyalty" sheet of the
*Store Master Sheet* workbook (Store ID, Rest. ID, name, emirate, opening date, menu type;
no contact details or staff names). When stores open or close, update the workbook and run:

```powershell
python "C:\Users\dgautam\OneDrive - Kuwait Food Company\Desktop\Codes\AmericanaProjects\MCPZOHO\daily-report\update-store-master.py" "C:\Users\dgautam\OneDrive - Kuwait Food Company\Store Master Sheet - July'26 (1).xlsx"
```

Stores that have closed but are still in the workbook go in `store-overrides.json` under
`closed` (Shawamekh Central Mall, 135124, is there); the builder leaves them out.

The builder uses it for store names and emirates, to catch stores that are in the master but
missing from Zoho's store list (their sales fail to save), and to list every store in the
restaurants table, including ones with no sales. `store-history.json` in the report folder keeps
each day's sales per store, so a store can be compared with its own normal day.

## What each day checks

| Section | Source | Flags |
| --- | --- | --- |
| Sales per restaurant | Transactions, store master | far below the store's usual for that kind of day (weekday or Sat/Sun weekend); no loyalty sales for 3+ days; stores missing from Zoho |
| Sales not saved | Till calls (ApiLog `Api_Type 0`, type 3) with no transaction | unknown or short store codes, engine errors |
| Points not burned | Till redemptions vs points burned; discounts with nothing burned | burned less than asked |
| Approved, no sale | Till type 5 checks with points and no sale post | possible lost redemptions |
| Refunds | Till type 4 calls vs Cancellation rows | refunds sent without a phone number are ignored by the engine |
| Expiry | Expiration rows, job logs, bonus rows past validity still holding points | overdue points, catch-up failures |
| Referrals | Referral bonus rows paired with sign-ups by second | bursts, 30-day volume, look-alike accounts |
| NCR logs | `ncr_logs` without the tier-job noise | engine errors, CRM limit, sign-up failures |
| App orders | Cart orders placed that day | failed orders (warning); orders the middleware never confirmed with a POS order id (info, a middleware item) |
| App usage | ApiLog by API type | account deletions |

Customer phone numbers are masked in the report. Emails are only used to compare referral
accounts and never leave the builder.
