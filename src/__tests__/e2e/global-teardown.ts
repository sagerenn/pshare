/** Playwright global teardown: stop the static site servers and the OpenList binary. */
import type { Harness } from "@/__tests__/harness/openlist-bin";
import type { StaticSite } from "@/__tests__/harness/next-app";
import type { PrefixProxy } from "@/__tests__/harness/prefix-proxy";

export default async function globalTeardown() {
  const g = globalThis as unknown as {
    __e2eOl?: Harness;
    __e2eSite?: StaticSite;
    __e2eUnconfigured?: StaticSite;
    __e2eBasepath?: StaticSite;
    __e2eTls?: StaticSite;
    __e2eOlProxy?: PrefixProxy;
  };
  try {
    if (g.__e2eSite) await g.__e2eSite.teardown();
  } catch {}
  try {
    if (g.__e2eUnconfigured) await g.__e2eUnconfigured.teardown();
  } catch {}
  try {
    if (g.__e2eBasepath) await g.__e2eBasepath.teardown();
  } catch {}
  try {
    if (g.__e2eTls) await g.__e2eTls.teardown();
  } catch {}
  try {
    if (g.__e2eOlProxy) await g.__e2eOlProxy.teardown();
  } catch {}
  try {
    if (g.__e2eOl) await g.__e2eOl.teardown();
  } catch {}
}
