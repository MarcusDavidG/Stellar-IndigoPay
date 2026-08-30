import { test, expect } from "@playwright/test";
import { mockFreighter } from "./fixtures/freighter";
import { mockHorizon } from "./fixtures/horizon";
import {
  mockApi,
  MOCK_PROJECT,
  MOCK_PROFILE,
  MOCK_LEADERBOARD,
} from "./fixtures/api";

/**
 * synthetic-donation.spec.ts — Workstream 7 (#1101)
 *
 * End-to-end synthetic transaction monitoring from the user surface.
 *
 * The backend already has a server-side synthetic monitor
 * (`scripts/synthetic-monitor.js` / `.github/workflows/synthetic-monitor.yml`)
 * that exercises the Horizon + Soroban RPC + API layers and publishes
 * `synthetic_donation_*` Prometheus metrics with a 7-step result gauge
 * (1 wallet, 2 build, 3 sign, 4 submit, 5 on-chain event, 6 backend record,
 * 7 leaderboard). This spec closes the browser gap that the backend monitor
 * cannot see: page load, wallet connection, form interaction, transaction
 * preview rendering, confirmation, and leaderboard reflection.
 *
 * It deliberately reuses the exact fixture/selector patterns proven by the rest
 * of frontend/tests/e2e/ (donation.spec.ts, dashboard.spec.ts) so it is
 * deterministic under the same json-server-backed CI topology, and runs as part
 * of the existing `frontend-e2e` job in .github/workflows/frontend.yml — no new
 * workflow or server is required.
 */
test("synthetic donation: wallet → form → confirm → dashboard → leaderboard", async ({
  page,
}) => {
  test.slow();

  await mockFreighter(page);
  await mockHorizon(page);
  await mockApi(page);

  // ── Layer 1: page load ─────────────────────────────────────────────────
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Fund the planet.");

  // ── Layer 2: project detail renders ────────────────────────────────────
  await page.goto("/projects");
  await expect(page.locator("h1")).toContainText("Climate Projects");
  await page.locator('[data-testid="project-card"]').first().click();
  await page.waitForURL(/\/projects\//);
  await expect(
    page.getByRole("heading", { name: MOCK_PROJECT.name }),
  ).toBeVisible();

  // ── Layer 3: connect wallet (donate form becomes active) ───────────────
  await page
    .locator('[data-testid="wallet-connect-button"]')
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.locator('[data-testid="donation-amount"]')).toBeVisible();

  // ── Layer 4: donation form + submission ────────────────────────────────
  await page.fill('[data-testid="donation-amount"]', "50");
  await page.click('[data-testid="donate-button"]');

  // ── Layer 5: confirmation ──────────────────────────────────────────────
  await expect(page.locator('[data-testid="donation-success"]')).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator('[data-testid="donation-success"]')).toContainText(
    "50 XLM",
  );

  // ── Layer 6: donor dashboard reflects the donation ─────────────────────
  await page.goto("/dashboard");
  await expect(page.locator("h1")).toContainText("My Impact");
  await page.click('[data-testid="wallet-connect-button"]');
  await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
  await expect(page.locator('[data-testid="donation-history"]')).toBeVisible();
  await expect(page.locator('[data-testid="donation-history"]')).toContainText(
    "Project donation",
  );

  // ── Layer 7: leaderboard reflects the donor ────────────────────────────
  // NOTE: the leaderboard has no <table>; each ranked entry renders as a `<div>`
  // whose donor name is a link (see components/LeaderboardTable.tsx), so we
  // assert on the donor's link by role + name rather than a table row.
  await page.goto("/leaderboard");
  await expect(page.locator("h1")).toContainText("Donor Leaderboard");
  await expect(
    page.getByRole("link", { name: MOCK_PROFILE.displayName }),
  ).toBeVisible();
  // Sanity-check the same donor entry the API mock returns is what's shown.
  await expect(
    page.getByRole("link", {
      name: MOCK_LEADERBOARD[0].displayName,
    }),
  ).toBeVisible();
});
