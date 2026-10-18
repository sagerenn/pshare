/**
 * Playwright global setup: build (if needed) and boot a real openlist-ext
 * binary with a provisioned scoped API key, then build the pshare static
 * export with that key baked in and serve it. The app URL is stashed on
 * process.env for the spec and the handles are kept on globalThis for the
 * teardown (same process).
 *
 * Two bundles are served: the configured one above (fixed port 3137, used by
 * the pre-existing specs) and an unconfigured one (fixed port 3138) built
 * with no build-time connection, for the specs that configure OpenList from
 * the page at runtime. The OpenList base URL and scoped key are exported via
 * process.env so worker processes can fill the settings form with them.
 */
import { ensureBinary, bootOpenList, type Harness } from "@/__tests__/harness/openlist-bin";
import { startStaticSite, startUnconfiguredStaticSite, type StaticSite } from "@/__tests__/harness/next-app";

let ol: Harness;
let site: StaticSite;
let unconfigured: StaticSite;

export default async function globalSetup() {
  await ensureBinary();
  ol = await bootOpenList();

  // Build the unconfigured bundle first: its out/ directory is copied to
  // out-unconfigured/ before the configured build overwrites out/.
  unconfigured = await startUnconfiguredStaticSite({ port: 3138 });
  site = await startStaticSite({ openlistBaseUrl: ol.baseUrl, apiKey: ol.apiKey, port: 3137 });

  (globalThis as unknown as {
    __e2eOl: Harness;
    __e2eSite: StaticSite;
    __e2eUnconfigured: StaticSite;
  }).__e2eOl = ol;
  (globalThis as unknown as { __e2eSite: StaticSite }).__e2eSite = site;
  (globalThis as unknown as { __e2eUnconfigured: StaticSite }).__e2eUnconfigured = unconfigured;
  process.env.PSHARE_E2E_URL = site.baseUrl;
  process.env.PSHARE_E2E_UNCONFIGURED_URL = unconfigured.baseUrl;
  process.env.PSHARE_E2E_OL_URL = ol.baseUrl;
  process.env.PSHARE_E2E_OL_KEY = ol.apiKey;

  // eslint-disable-next-line no-console
  console.log(
    `e2e ready: site=${site.baseUrl} unconfigured=${unconfigured.baseUrl} openlist=${ol.baseUrl}`,
  );
}
