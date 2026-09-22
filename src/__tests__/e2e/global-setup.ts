/**
 * Playwright global setup: build (if needed) and boot a real openlist-ext
 * binary with a provisioned scoped API key, then build the pshare static
 * export with that key baked in and serve it. The app URL is stashed on
 * process.env for the spec and the handles are kept on globalThis for the
 * teardown (same process).
 */
import { ensureBinary, bootOpenList, type Harness } from "@/__tests__/harness/openlist-bin";
import { startStaticSite, type StaticSite } from "@/__tests__/harness/next-app";

let ol: Harness;
let site: StaticSite;

export default async function globalSetup() {
  await ensureBinary();
  ol = await bootOpenList();
  site = await startStaticSite({ openlistBaseUrl: ol.baseUrl, apiKey: ol.apiKey, port: 3137 });

  (globalThis as unknown as { __e2eOl: Harness; __e2eSite: StaticSite }).__e2eOl = ol;
  (globalThis as unknown as { __e2eOl: Harness; __e2eSite: StaticSite }).__e2eSite = site;
  process.env.PSHARE_E2E_URL = site.baseUrl;

  // eslint-disable-next-line no-console
  console.log(`e2e ready: site=${site.baseUrl} openlist=${ol.baseUrl}`);
}
