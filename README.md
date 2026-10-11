# Gym Log

A personal gym tracker that runs on your phone as an installable web app.

- Plan workouts by date, log sets (reps × weight) with a rest timer, and track bodyweight.
- Progress charts for estimated rep maxes, heaviest set and volume, with PRs marked.
- Calorie and protein estimates from your profile.
- Works offline. All data is stored only on the device (IndexedDB), with JSON backup export and restore.

## Install on iPhone

Open the GitHub Pages link in Safari, tap Share, then **Add to Home Screen**.

## Development

No build step: plain HTML, CSS and JavaScript. Serve the folder with any static server, e.g. `npx http-server .`.
When changing app files, bump `VERSION` in `sw.js` so installed copies pick up the update.
