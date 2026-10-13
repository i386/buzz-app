// The only base `test` for browser journeys. Lint (biome.json) rejects
// importing `test` from @playwright/test anywhere else.
//
// A route handler can still be running when its test ends, for example while
// it fulfills a request that the test never waited for. Closing the context
// then rejects the handler's page or context calls (page.evaluate,
// route.fetch), and Playwright reports that rejection as a failure of the
// finished test. Teardown stops every route before the context closes and
// ignores errors from handlers still in flight. An error that a handler raises
// while the test runs still fails the test.
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

export const test = base.extend({
  context: async ({ context }, use) => {
    await use(context);
    await Promise.all([
      context.unrouteAll({ behavior: "ignoreErrors" }),
      ...context
        .pages()
        .filter((page) => !page.isClosed())
        .map((page) => page.unrouteAll({ behavior: "ignoreErrors" })),
    ]);
  },
});
