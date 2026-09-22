/** Playwright global teardown: stop the static site server and the OpenList binary. */
import type { Harness } from "@/__tests__/harness/openlist-bin";
import type { StaticSite } from "@/__tests__/harness/next-app";

export default async function globalTeardown() {
  const g = globalThis as unknown as { __e2eOl?: Harness; __e2eSite?: StaticSite };
  try {
    if (g.__e2eSite) await g.__e2eSite.teardown();
  } catch {}
  try {
    if (g.__e2eOl) await g.__e2eOl.teardown();
  } catch {}
}
