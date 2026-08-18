import { expect, test as base } from "@playwright/test";

import { E2E_APP_ORIGIN, bootstrapE2ePage } from "./bootstrap";

export type * from "@playwright/test";

type E2eFixtures = {
  automaticE2eBootstrap: undefined;
  /**
   * Set false only when a test must inspect or configure the page before its
   * first app navigation.
   */
  e2eBootstrap: boolean;
};

const test = base.extend<E2eFixtures>({
  e2eBootstrap: [true, { option: true }],
  automaticE2eBootstrap: [
    async ({ page, baseURL, e2eBootstrap }, use) => {
      if (e2eBootstrap) {
        if (!baseURL) {
          throw new Error(
            "E2E app navigation requires Playwright use.baseURL.",
          );
        }
        const expectedOrigin = new URL(baseURL).origin;
        if (expectedOrigin !== E2E_APP_ORIGIN) {
          throw new Error(
            `E2E app origin mismatch: Playwright baseURL resolves to ${expectedOrigin}, expected ${E2E_APP_ORIGIN}.`,
          );
        }
        await bootstrapE2ePage(page, { expectedOrigin });
      }
      await use();
    },
    { auto: true },
  ],
});

export { expect, test };
