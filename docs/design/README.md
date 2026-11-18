# Timber Workbench

[Reviewed interactive preview](timber-workbench-preview.html) is the standalone sample-data build approved during the design sessions. Open the file in a browser to review the 16 routes, switch preview roles, or try the simulated administration flows.

The dashboard uses the Timber palette and layout in `web/styles/timber.css`, `timber-views.css`, and `timber-charts.css`. It keeps the existing application and data sources. The preview provides a reference for spacing and composition, including the admin concepts that need data beyond those sources.

- The overview uses the existing GTNH mark, a centered landing composition, and collapsed Helpful Links. Developer and Administration links follow the authenticated team and role respectively. Keep the five summary cards and the seven date ranges.
- Use timber for the rail, muted stone or cream for light mode, and brown or graphite for dark mode. Moss is a selective accent. Keep buttons compact and tactile, preserve solid row and column boundaries, and keep chart axes and tabular numerals readable.
- Use the full-width artwork treatment on query and admin headers, side artwork on analytics, and a text-first layout at narrow widths. Keep a small title-and-author disclosure on each image.
- Query pickers and search keep their existing live results. Keep 24 naturally wrapping Quick Select chips. Pin the signed-in GitHub contributor when that login is available, and rank their repository contributions ahead of organization-wide activity.
- Keep chart grouping local to the chart and reserve the right-aligned page control for the date range. Expanded modules open from the card footer. Back restores dashboard scroll and filters, and stays disabled on a direct entry.
- The live CI Health view uses the existing default-branch sample and its per-repo rollups. Rulesets links to the live organization settings. The run-level CI and ruleset inventory concepts remain in the reviewed preview. The six other admin views use their native releases, labels, logs, permissions, and webhook workflows.

## Artwork

The scenes in `web/assets/scenes/` come from the [GTNH showcase](https://www.gtnewhorizons.com/) and the [modpack’s main-menu assets](https://github.com/GTNewHorizons/GT-New-Horizons-Modpack/tree/master/config/txloader/load/mainmenu/textures/backgrounds). The image disclosures are defined in `web/js/artwork.js`; keep attribution with the image when replacing or reusing a crop.
