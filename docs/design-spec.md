# Gym Log design spec

Approved by G on 2026-10-11. Mockups: https://claude.ai/artifact/NNnGCGejQdxew8cGDijMrB (Today, Workout in progress, Progress, Body).
Written by the design thread, which does not edit app code. The building thread owns the implementation.

## 1. Smoothness (G's explicit requirement: no lag or stutter)

Found in the current code (2026-10-11):

1. **Whole screen rebuilt on every tap.** `render()` (`app.js` ~line 191) replaces `#view.innerHTML` for every action, including ticking a set. On a long workout this repaints everything, can jump the scroll position, and drops keyboard focus.
   - Fix: update only what changed for frequent actions (set done, add/remove set, rest timer). Ticking a set should toggle classes on that one row. Keep full re-render for tab changes only.
2. **Full save on every keystroke.** The `input` listener calls `save()`, which runs `JSON.stringify(state)` and a synchronous `localStorage.setItem` each time. This grows with history and blocks typing.
   - Fix: debounce the localStorage write (~300 ms), and flush immediately on `visibilitychange` (hidden) and `pagehide` so nothing is lost when the app is closed.
3. **Slow launch on bad gym Wi-Fi.** `sw.js` is network-first, so opening the app waits on the network before falling back to cache.
   - Fix: cache-first for the app shell with a background update (stale-while-revalidate). The app should open instantly offline or on weak signal.
4. **Charts recomputed from all history on each render.**
   - Fix: compute per-exercise history once per data change and cache it; draw only the selected range.

General rules:
- Animate only `transform` and `opacity`. Transitions 150–200 ms, ease-out. Respect `prefers-reduced-motion`.
- `touch-action: manipulation` on buttons and inputs; visible pressed state (`:active` scale 0.97) so taps feel instant.
- The rest timer updates one text node with `requestAnimationFrame` or a 1 s tick, never a re-render.
- Tab switches keep each tab's scroll position.
- Target: taps respond within 100 ms on a mid-range phone; no visible jank when ticking sets in a 6-exercise workout.

## 2. Look

- Dark first: ground `#0e0f11`, card `#17181c`, raised `#23252b`, line `#2a2c33`, text `#f2f2f3`, muted `#a1a3ab`.
- Accent green `#34d399` (ink on accent `#062b1e`). Amber `#f5b94a` for PRs and the goal line.
- System font. Big titles 34 px / 800. Numbers use `font-variant-numeric: tabular-nums`.
- Cards radius 22 px, chips fully rounded, buttons 14–16 px radius. Touch targets ≥ 44 px; workout inputs 48 px; primary buttons 52–56 px.
- Replace emoji tab icons with simple line (stroke) SVG icons: Today, Plan, Progress, Body, More.

## 3. Screens

**Today:** date + large "Today" title; 7-day week strip (done = tinted, today = solid accent, planned = outlined, rest = dim); scheduled workout card with exercise chips and a big "Start workout" button, "Pick a different workout" as a text button; three stat tiles (workouts this week, bodyweight, PRs this month); Recent list.

**Workout in progress:** full screen, tab bar hidden. Top bar: minimise, workout name with elapsed time and sets done, Finish button. Current exercise card: name, "Last time" line, set rows (set no., previous, kg, reps, tick) with 48 px inputs; done rows tinted green. "+ Add set". Remaining exercises as compact cards with progress (0 / 3). Rest timer bar pinned at the bottom: countdown, progress bar, +30s, Skip. Starts automatically when a set is ticked.

**Progress:** lift chips across the top; card with segmented toggle (Est. 1RM · Heaviest · Volume), big current value with change, line chart with amber PR dots, range chips (4W · 3M · 1Y · All). Below: "All lifts" list with sparkline and change. Matches `docs/progress-charts-plan.md`.

**Body:** "Log today's weight" card with −/+ steppers (0.1 kg) around a big value and Save; tiles (7-day avg, 30-day change, kg to goal); chart with daily dots, 7-day average line, dashed amber goal line.

Plan and More keep their current structure in the new style.
