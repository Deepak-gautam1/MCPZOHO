# Peet's Loyalty Platform — architecture notes

Derived from the `.ds` exports in this folder (generated 26-Aug-2026, 60,728 lines).
Full write-up: https://claude.ai/code/artifact/015a211c-b160-4174-98c1-8d89e512245b

> **Two-brand view:** https://claude.ai/code/artifact/7c2591ac-5373-448f-a42a-15e54520e3dc
> covers how Peet's and Krispy Kreme relate. This file is the Peet's-internal reference.

## App graph — 8 apps, all exported

Cross-app calls use `app_link_name.namespace.function()` and `app_link_name.Form.ID`.

| App | Link name | Exported | Role |
|---|---|---|---|
| Peets Coffee Rewards | `test_peets_new` | yes | Hub: customers, points ledger, cart/order, mobile API |
| Peets Product Catalogue | `copy_of_product_catalogue` | yes | Products, modifiers, price lists |
| Peets Restaurant Mgmt | `peets_restaurant_management` | yes | Stores, areas, delivery polygons |
| Global Configuration | `global_configuration` | **no** | Markets, currency, nationality master data |
| Product Catalogue | `copy_of_product_catalogue_management` | **no** | Second catalogue app |
| Restaurant Management | `restaurant_management` | **no** | Second restaurant app |
| Krispy Kreme | `krispy_kreme` | yes | **KK hub** — fork of Peets, frozen pre-V2 |
| Loyalty Engine Handler | `loyalty_engine_handler` | yes | Test harness only, 1 function, no callers |

### Two stacks, not one

- **Peet's:** `test_peets_new` + `copy_of_product_catalogue` + `peets_restaurant_management`
- **Krispy Kreme:** `krispy_kreme` + `copy_of_product_catalogue_management` + `restaurant_management`

The unprefixed "Product Catalogue" and "Restaurant Management" are **Krispy Kreme's**, not
shared. The Peet's stack nonetheless calls into them 26 times — accidental coupling.

KK is a fork of Peets: 22/23 `loyaltyEngine` names shared, 9/9 `loyaltyEngineCSS` identical,
33/43 forms shared, but 7 `_V2` functions vs Peets' 82. **KK has no sign-up bonus and no
`Validate_User_Tier_Status`** — it predates all three defects below.

Both hubs POST to the same custom API with the same public key:
`/creator/custom/.../loyaltyengine?publickey=FMEamPZgfV5gpDjkJY0t8M7Ef` — rotating it requires
changing both. `global_configuration` is referenced 85× by Peets and **0× by KK**.

Rewards calls *both* catalogue apps and *both* restaurant apps — establish whether that is
deliberate tiering or copy drift before trusting any master-data read.

## Object counts

| App | Forms | Pages | Functions | Lines |
|---|---:|---:|---:|---:|
| Rewards | 62 | 23 | 266 | 41,099 |
| Catalogue | 19 | 3 | 62 | 13,153 |
| Restaurant Mgmt | 15 | 4 | 45 | 6,476 |

## Key namespaces (Rewards)

`fetchRecords` (65) · `loyaltyEngine` (64) · `customerProfile` (18) · `publicUrls` (12) ·
`cartmanagement` (12) · `loyaltyEngineCSS` (9) · `maintainance` (7) · `accounts_handler` (6) ·
`apiEndPoints` (4) · `crmIntegration` (2)

## Mobile API

Single gateway `apiEndPoints.main(string requestParams)` + `main_guest`, dispatching on
integer `request_params.api_type` through `if (action == N)` branches, 1–16 and 18–38
(**17 is absent**). Every call logged to `ApiLog` first, inside its own try/catch.

## Loyalty model

- `Customer_Points_System` — per-customer balance (one row/customer). Derived-but-stored.
- `Transaction` — append-only journal; `Status` in `Not Utilized` / `Partially Utilized` / utilised.
- Tiers from `Membership_Points_System`, rolling 90-day earned points: Silver ≤7,499 · Gold ≤14,999 · Platinum ≥15,000.

## Live automation (batchworkflow, all daily, batch 1000)

| Name | Population | Since |
|---|---|---|
| `Expire_Free_Drink` | `Customer_Points_System[Is_Free_drink_available == true]` | 01-Sep-2024 |
| `Validate_User_Tier_Status` | `Customer_Points_System` | 24-Mar-2025 |
| `Expire_Loyalty_Points` | `Transaction[Status == "Not Utilized" \|\| "Partially Utilized"]` | 01-Nov-2025 |

Four entries in the plain `schedule` block are **inactive** — the per-record originals that
these batch sweeps replaced. All three schedules audit into `ncr_logs`.

## Integrations

NCR POS (`sendordertopos`, `ncrInput`/`ncrCallType` → `ncr_logs`) · Zoho CRM (`zoho.crm.*`,
plus a v6 REST DELETE) · Loyalty Engine Handler (`invokeurl` custom API) · Google Places
(Restaurant Mgmt) · Azure (`azurefunction.*`) · Payment (`payment_config.*`).

## Known defects

1. **`creditbonuspoint_V2` guard conditionally assigned** (~25036) — `already_signup` is set
   only inside `if(customer_points.count() > 0)`; customers with no ledger row bypass the
   guard and are re-credited. Interacts with #2.
2. **`Customer` on-add workflow is fully commented out** (~29823) — used to create the
   `Customer_Points_System` row, set Silver, push to CRM and call `creditbonuspoint`.
3. **Tier scheduler reads the collection, not the loop row** (~31503) —
   `eligibleRecordsForTierValidation.Last_90_days_schedule_triggered_on` inside
   `for each data in ...`; every customer scored against the first record's window.
4. **Tier eligibility uses `==` on a date** (~31488) — `== zoho.currentdate.subDay(90)`;
   any customer off that exact boundary is skipped permanently. Should be `<=`.
5. **Custom API public keys in source** (14497, 29619, 29645, 29672) — treat as disclosed, rotate.
6. **`range from 0 to 0` (15×) vs `range from 0 to 1` (33×)** — used interchangeably for
   "one record", including in the two disagreeing signup guards. Verify semantics before editing.
7. **Three signup implementations** — V1 guards `Type_field == "Signup"`, V2 guards
   `Bonus_Type == "Sign Up"` but writes `Type_field = "Bonus"`. They cannot see each other's rows.
8. **`ncr_logs` doubles as scheduler audit log** — POS errors and job completions share a form.

## Ground rules

Read-only mirror — edits happen in the Creator builder, not here. The `peetsmcp` server
(`../`) reads live data; its credentials carry delete scope, and
`zoho_creator_call_function` executes against production.
