# Mapus source baseline

Repository: https://github.com/alyssaxuu/mapus
Pinned commit: `c1aa763bb6fabbbca00b45862512fff746107e72` (2022-07-02)
Author: Alyssa X / alyssaxuu. MIT license is retained in `LICENSE`.

This directory is a **partial source reference**, not a runnable Mapus distribution. It contains the original `README.md`, `LICENSE`, `src/index.html`, `src/main.js`, `src/styles.css`, and the seven selected SVG controls/icons used or considered by the CityWalk Demo. Other assets, Leaflet's bundled JavaScript, and the large preview GIF are omitted because the Demo replaces the map engine with Baidu and removes rooms.

`src/index.html` and `src/main.js` were recovered from the prior Mapus teardown workspace; their Git blob SHA-1 values were verified against the repository tree from the pinned commit. README, stylesheet, license, and SVG files were retrieved from GitHub's official contents/blob API at the pinned commit and verified against the same tree. Direct clone and archive download were unavailable during this run. No nested `.git` directory is retained.

No `AGENTS.md` exists in the pinned upstream tree. The original main.js is kept for inspection only and is not loaded by the Demo. Original Firebase configuration uses placeholders. The actively adapted zoom control files and copied icons live in `public/mapus-assets/`, with their own attribution and MIT license.
