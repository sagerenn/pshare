/** Playwright global teardown: stop the Next app and the OpenList binary. */
import type { Harness } from "@/__tests__/harness/openlist-bin";
import type { NextApp } from "@/__tests__/harness/next-app";

export default async function globalTeardown() {
  const g = globalThis as unknown as { __e2eOl?: Harness; __e2eApp?: NextApp };
  try {
    if (g.__e2eApp) await g.__e2eApp.teardown();
  } catch {}
  try {
    if (g.__e2eOl) await g.__e2eOl.teardown();
  } catch {}
}
