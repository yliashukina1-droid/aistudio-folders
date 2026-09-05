# Contributing

Thanks for looking. This is a small, single-file userscript — the whole thing is [`src/index.ts`](src/index.ts).

## Setup

Requires [Bun](https://bun.com). No other toolchain.

```bash
bun install
bun run check     # tsc --noEmit && biome check .
bun run build     # -> dist/aistudio-folders.user.js
```

`bun run check` is exactly what CI runs. Please get it green before opening a PR. A [lefthook](https://github.com/evilmartians/lefthook) pre-commit hook formats staged files if you have lefthook installed; it is optional.

## Testing your change

**There is no automated test suite, and you cannot avoid testing by hand.**
The script is almost entirely DOM manipulation against a page we do not control, so a green `bun run check` proves it compiles, not that it works.

To try a build:

1. `bun run build`
2. In Tampermonkey or Violentmonkey, create a script from `dist/aistudio-folders.user.js`, or enable local file access and point it at the file so rebuilds are picked up.
3. Hard-reload `aistudio.google.com/library` (the history page).

Worth exercising after any change that touches rendering or storage:

- Create, rename, recolour, nest and delete a folder
- Drag one chat, and a multi-selection, onto a folder and onto `Unfiled`
- Filter, then sort both ways, and confirm `All chats`/`Unfiled` stay pinned
- Run **Scan all history** and confirm the `+` disappears from the counts
- Export a backup, clear `localStorage`, re-import it
- Reload and confirm everything survived

If you change anything under `db`, test the **upgrade** path too: load the page with an old store present, not just a fresh one.

## Working against AI Studio's markup

The script targets selectors that are not a public API:

| Selector                                                          | Used for                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ms-library-table section.lib-view`                               | Layout host — the rail is prepended here, and this becomes the grid                                   |
| `ms-library .page-content-wrapper`, `.page-content-inner-wrapper` | AI Studio centres the page with a `max-width` here; we release it so the rail can reach the left edge |
| `table.library-table tbody tr.mat-mdc-row`                        | Chat rows                                                                                             |
| `td.icon-cell`                                                    | Host for the per-row folder button                                                                    |
| `td.icon-cell .prompt-icon`                                       | AI Studio's row icon, hidden because we replace it                                                    |
| `a.name-link[href*="/prompts/"]`                                  | Source of a chat's ID                                                                                 |

Two behaviours are relied on without being selected directly. `.lib-table-wrapper` carries native `-16px` side margins that bleed the table to the edge — don't override its width or margins. And `.lib-table-wrapper` is `ng-star-inserted`, so it does not exist on the first tick; anything positioned relative to it has to cope with that.

When something breaks, save the live page (**Save Page As → Complete**) and diff the structure against what the code expects. That is how the current selectors were pinned down.

**Never commit that capture.** A saved AI Studio page embeds your own chat titles, prompt IDs and account details, and a backup exported from the Folder Manager maps your chat IDs to folders.

## Conventions

- **TypeScript is strict, and `bun run check` must pass with zero errors.**
  Prefer a real type over `any`.
- **Comments explain _why_, not _what_.**
  Several rules in the stylesheet exist to work around a specific AI Studio behaviour; if you touch one, keep the reason with it. A comment that only restates the code will be asked about in review.
- **Match the native look.**
  The rail is meant to read as part of AI Studio, so use its CSS custom properties (`--color-v3-*`, `--v3-shadow-lg`) rather than hard-coded colours. Note that AI Studio loads **Inter at 400 and 500 only** — asking for another weight makes the browser fake it, which looks like a glow.
- **Do not store chat content.**
  Only the mapping from chat ID to folder ID. Titles were removed on purpose.
- Formatting is Biome's: 2-space indent, double quotes, 100 columns.
  `bun run lint:fix` applies it.

## Performance notes

`tick()` runs on a throttled `MutationObserver` plus a 1.5s interval, so anything it calls happens often. Two things there are easy to regress:

- **The observer is detached for the whole of `tick()`.**
  Every DOM write we make would otherwise re-trigger it, which becomes a permanent churn loop rather than settling. Keep mutations inside that window.
- **Avoid per-row and per-folder work that scales badly.**
  Folder counts are computed in one pass by `computeCounts()`; the previous per-folder version ran a descendant walk _and_ a full item scan for every folder drawn.

## Releasing

`package.json` is the single source of truth for the version — `build.ts` stamps the userscript banner from it, and the release workflow **fails the build if the tag does not match**.

```bash
# bump "version" in package.json, commit, then:
git tag v1.2.3
git push origin v1.2.3
```

The workflow typechecks, lints, builds, and attaches `dist/aistudio-folders.user.js` to a GitHub release.

## Reporting bugs

Please include your browser and version, your userscript manager, the script version from the banner, and anything in the devtools console prefixed `[AIS Folders]`. A screenshot of the history page helps a great deal, since most bugs here are visual — **crop or blur your chat titles** if they are sensitive.
