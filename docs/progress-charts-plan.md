# Progress charts plan

Scope: the phone app in `gym-phone-app/` only (not the laptop tracker). No code has been changed yet.

## What exists today
- `lineChart()` in `app.js` draws a plain SVG polyline with 3 gridlines and first/last date labels.
- **Body** tab: one line of the last 120 bodyweight entries, plus Latest / 7-day / 30-day change tiles.
- **Progress** tab: per-exercise picker, estimated 1RM line (Epley, best set per session), plus Heaviest / Best 1RM / 1RM change tiles.
- Data already supports everything below: `state.bodyweight = [{date, kg}]` and `state.sessions[].entries[].sets[] = {weight, reps, done}`. No storage changes needed.

## Proposed changes

### 1. Shared chart upgrades (one function, used by both tabs)
- **Range chips** above each chart: 4W · 3M · 1Y · All (default 3M). Remembered per tab in `ui`.
- **Tap to inspect**: tapping or dragging on the chart shows the nearest point's date and value in a small label, with a vertical guide line.
- **Better axes**: 3 to 4 month or week labels along the bottom instead of only first/last.
- Stays dependency-free inline SVG so the app keeps working offline.

### 2. Bodyweight chart
- Daily weigh-ins as light dots, with a **7-day rolling average** as the main line. Daily weight swings by 1 to 2 kg from water and food, so the average is the honest trend.
- Optional **goal weight** (set in More) drawn as a dashed line, with a "x kg to go" tile.
- **Weekly change, resetting on Monday**: weeks run Monday to Sunday. "This week" = latest weigh-in minus the first weigh-in on or after this Monday, so it starts at 0 each Monday and builds through the week. Shows "–" until there are two weigh-ins in the week.
- **Weekly bars**: a small bar chart under the trend with one bar per Mon–Sun week (last minus first weigh-in that week), bars above the line for a gain and below for a loss, with the week's start date under each. It follows the range chips.
- Tiles become: Latest · This week (since Mon) · change over the selected range.

### 2a. Editing past bodyweight entries (Body tab)
- Keep the "Log today's weight" card from `design-spec.md` (−/+ steppers, big value, Save). No spreadsheet table.
- Add a **date row** on the card: ‹ and › arrows step one day back or forward, and tapping the date opens the date picker. It defaults to today and can't go past today. The title changes from "Log today's weight" to e.g. "Weight for Thu 9 Oct".
- When the chosen date already has an entry, the steppers start at that value and the button reads **Update** instead of Save. Saving overwrites that date's entry (one entry per date, as now).
- **Tap any row in the Entries list** to load that date into the card and scroll up to it. Delete stays on the row.
- After saving a past date, the card jumps back to today.

### 2b. Calorie and protein estimates (Body tab)
- **One-time profile** in More: height, age, sex, activity level (Sedentary 1.2 · Light 1.375 · Moderate 1.55 · Very active 1.725). Stored in `state.settings.profile`; nothing leaves the phone.
- **Weight used**: the 7-day average, falling back to the latest weigh-in, so one heavy day doesn't move the numbers.
- **Maintenance calories (TDEE)**: Mifflin-St Jeor BMR (`10×kg + 6.25×cm − 5×age + 5` for men, `− 161` for women) × activity level, rounded to the nearest 50 kcal.
- **Three cards**, with the one matching your chosen goal highlighted:
  - Lose: maintenance − 500 kcal (about 0.5 kg a week). Protein 2.0 g/kg.
  - Maintain: maintenance. Protein 1.6 g/kg.
  - Gain: maintenance + 300 kcal (about 0.25 to 0.3 kg a week, a lean bulk). Protein 1.8 g/kg.
- **Goal check**: compares your last few weekly bars with the goal's expected rate and says e.g. "Gaining 0.6 kg/week, faster than a lean bulk. Try about 200 kcal less."
- Shows "Add your height, age and activity in More" until the profile is filled in. Labelled as an estimate, not medical advice.

### 3. Lift charts (Progress tab)
- **Metric toggle**: Est. max (default) · Heaviest set · Session volume (sets × reps × weight).
- **Rep-max chips** under Est. max: 1RM · 3RM · 5RM · 10RM (default 1RM, remembered per exercise). Each session's value is estimated from its best set: 1RM by Epley (`w × (1 + r/30)`), then N-rep max = `1RM ÷ (1 + N/30)`. If you actually did a set at exactly N reps, that weight is used instead when it's higher, and the dot is drawn solid (estimated values are hollow). The stat tiles follow the chosen rep count, e.g. "Best est. 5RM".
- **PR markers**: a highlighted dot each time a new all-time best is set, and a "PRs" count tile.
- **All-lifts overview**: a list of every exercise with a small sparkline and its 1RM change over the selected range, so you can scan everything without the picker. Tapping a row opens the full chart.

## Build order
1. Shared chart upgrades (range chips, tap to inspect, axes).
2. Bodyweight rolling average, weekly change (resets Monday) and goal line.
2b. Profile in More, calorie and protein cards, and goal check.
3. Lift metric toggle, rep-max chips (1RM/3RM/5RM/10RM) and PR markers.
4. All-lifts overview with sparklines.

Each step is small and can be checked on the phone before the next.
