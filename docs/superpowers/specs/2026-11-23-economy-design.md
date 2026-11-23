# Economy tab: design

Asked for by Josh on 2026-11-23, after a brainstorm and four mockups (`economy/mockups/` in the project files).

## Why

A campaign tracks what the party has (Party → Holdings) but not what things cost, where the money went, or what the
party owes people. And many games don't run on coins at all: post-apocalypse games barter, others use a wealth
rating, and in some the currency is favours. The Economy tab is one place for all of that, which a GM switches on
piece by piece.

## Goals

- A campaign picks any mix of four **ways to pay**: coins, barter, wealth and favours. A price can be given in each.
- A **price book** of goods and services, with a short list of everyday prices filled in first, an upload from a
  spreadsheet (CSV), and **shifts** that change prices or availability in a region for a while.
- A **ledger**: a dated history of what the party gained, spent, owed and repaid, in every way to pay, with regular
  costs (upkeep, wages, rations) posted as the campaign's days pass.
- **Favours**: who owes whom, in three sizes with a free-text description, open until called in, repaid or forgiven.

## Not in this change

- No simulation: prices only move when the GM adds a shift. No settlement or faction wealth, no trade routes.
- No prices or currency rules from a published game are shipped. The everyday item names are our own.
- The app does not roll for wealth. It records the level and its changes.
- No ledger for a character's personal funds; no favours on Encyclopedia entries or character sheets yet.
- Spreadsheets upload as CSV (what every spreadsheet program saves), not .xlsx.

## Approaches considered

1. **Extend Party Funds** with a history and stop there. Smallest, but only coins, and no prices.
2. **Coins first, other economies as free-text notes.** Simple tables, but barter, wealth and favours would be
   workarounds, which is what Josh asked to avoid.
3. **Ways to pay as a campaign setting, every price and ledger line in any of them** (picked). One price book row
   holds a cost per way to pay; one ledger holds every kind of change. Slightly wider tables, but each economy is a
   first-class thing and they mix freely.

## Where it lives

A new **Economy** tab in the World group, after Encyclopedia, with four halves: Price book, Ledger, Favours, and
Setup (GMs only). Party Funds stays on Party → Holdings; the ledger changes the same rows.

## Who can do what

- GMs: setup, the price book, shifts, secret items and secret favours.
- Every member: reads the price book (not secret rows) and the ledger; adds ledger entries, regular costs and
  favours; settles favours; sets the wealth of a character they may edit. A member deletes their own ledger entry, a
  GM any.

## Data (migration `059_economy.sql`)

- `economy_config` (one row per campaign): `config_json` with the four ways to pay. Coins: a base unit and other
  units worth so many of it. Barter: the good everything is measured in, and other trade goods worth so many of it.
  Wealth: the level names, lowest first. Favours: on or off.
- `economy_items`: the price book. `coin_cost` (in the base coin), `barter_cost` (in the reference good),
  `wealth_level`, `favour_size` (1 to 3), `availability` (common, scarce, rare, none), `is_everyday`, `is_secret`.
- `economy_shifts`: a region (or everywhere), a category or one item (or everything), a multiplier, an availability
  to use instead, a reason, and the day it ends (or never).
- `economy_ledger`: day, kind (coins, goods, wealth, favour, note), signed amount and its unit, what it was for,
  where it came from (by hand, upkeep, reward, favour), the funds line or gear row it changed, whose it is, secret
  or not.
- `economy_costs`: a regular cost: amount, the funds line or trade good it is paid from, every how many days, and
  the next day it is due. `set_time` posts every one that has come due.
- `economy_wealth`: a character's (or the party's) wealth level.
- `economy_favours`: who on the party's side, the other side's name (linked to an Encyclopedia entry of that name),
  direction, size, what for, since which day, secret or not, and how and when it was settled.

All are copied with a campaign and exported with it.

## How the pieces behave

- **Coins** are typed and shown in the campaign's units ("1 sm 5 bits") and stored as a number of the base unit.
  A Party Funds line counts toward the party's coins when its currency is named like a unit.
- **Barter** stock is counted from Gear and Loot rows named like a trade good.
- **Shifts** multiply an item's coin and barter cost and may replace its availability, for the region the party's
  main group is in (or one picked from the list). An ended shift stops applying by itself.
- **Can the party afford it?** compares the shifted price with the party's coins, its trade goods, each
  character's wealth and whether favours are on, and offers to pay each way, which opens a ledger entry or a favour
  already filled in.
- **Ledger entries** in coins or goods change the funds line or gear row they name, in one transaction. Changing a
  Party Funds amount by hand writes a ledger line too. Deleting an entry does not undo the change; the dialog says
  so.
- **Favours** write a ledger line when made and when settled. A secret favour's lines are secret until revealed.

## Tests

`tests/browser/economy.spec.js` (setup, price book and shifts, upload, afford, ledger and regular costs, favours,
what a player may and may not do) and `economy-logic.spec.js` (coin parsing and formatting, shifts, CSV).
