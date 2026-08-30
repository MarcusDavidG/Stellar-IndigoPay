# Visual Regression Testing (issue #1101, WS5)

The frontend catches CSS/layout/rendering regressions by comparing committed
Playwright screenshots (`toHaveScreenshot`) against baselines stored under
`frontend/e2e/visual.spec.ts-snapshots/`. The suite lives in
`frontend/e2e/visual.spec.ts` and runs under `frontend/playwright.v2.config.ts`
(route-mocked, desktop viewport, real production build).

## Where it runs

- **General CI jobs** (`frontend.yml`) skip the visual suite on purpose — its
  snapshots are OS/font-render specific and would flake on a runner whose
  image differs from the one the baselines were generated on.
- **`.github/workflows/frontend-visual.yml`** opts the suite IN
  (`VISUAL_REGRESSION=1`) and diffs it against the committed baselines on
  every PR touching `frontend/**`, uploading the diff report artifact.

> **Current gate mode — report-only.** The committed `project-detail` baselines
> were generated outside CI and do not reproduce on `ubuntu-latest` (they
> render an external asset — e.g. a cover image or map tiles — that CI cannot
> fetch), while the `homepage`/`dashboard` baselines match. Because a strict
> diff would red-block on baselines that can only be regenerated inside CI, the
> workflow's diff step is `continue-on-error: true` (informational) until
> authoritative baselines are captured **in CI**. To re-enable a blocking gate:
> run the `update-baselines` workflow_dispatch, download the regenerated
> snapshot artifact, review and commit it — then remove `continue-on-error`
> from `.github/workflows/frontend-visual.yml`.

## Baseline maintenance workflow

An intentional design change will make the visual job fail with a pixel diff.
That is the signal to update the baseline — but only with reviewer sign-off:

1. The PR author **regenerates** the baselines:
   ```bash
   cd frontend
   # local, against the same Chromium you develop with
   npx playwright test -c playwright.v2.config.ts --grep "Visual regression" --update-snapshots
   ```
   Or, in CI, a maintainer triggers the **`update-baselines`**
   `workflow_dispatch` on `frontend-visual.yml`; the job uploads the
   regenerated `visual.spec.ts-snapshots/` as an artifact.
2. Inspect the diff — make sure the change is the intended layout/theme/type
   change and nothing incidental (fonts, ordering, overflow).
3. Commit the new baselines **in the same PR** and get a **reviewer
   approval** that the change is cosmetic and intentional.
4. The visual job turns green.

## Adding pages / themes / viewports

The epic targets every critical page in light **and** dark, at desktop and
mobile viewports. To extend coverage safely:

1. Add a `test("...", ...)` case to `frontend/e2e/visual.spec.ts`
   following the existing pattern:
   - apply the theme up-front with `page.addInitScript(() => {
window.localStorage.setItem("stellar-indigopay-theme", "<light|dark>"); })`
     **and** `await page.waitForFunction(() =>
document.documentElement.classList.contains("dark"))` so a silent
     no-op never baselines the wrong theme;
   - gate the capture behind a stable assertion (don't snapshot a still-hydrating
     page), settle animated counters, and pass `{ fullPage: true,
animations: "disabled" }`.
2. Generate the baseline once locally with `--update-snapshots` and commit it.
3. A project added to the visual suite must never snapshot PII/production
   data — use the route mocks / fixtures (`frontend/e2e/mocks/*`,
   `frontend/e2e/fixtures/projects.ts`) only.

## Baselines storage

Baselines are committed PNGs. If the combined size ever exceeds ~1 MB, move
`frontend/e2e/visual.spec.ts-snapshots/` to Git LFS with a `.gitattributes`
track rule (`*.png filter=lfs diff=lfs merge=lfs -text`).
