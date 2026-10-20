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
 * the page at runtime. A third bundle (port 3139) is built with
 * NEXT_PUBLIC_BASE_PATH=/pshare and served under that prefix, covering the
 * GitHub Pages deployment shape (see base-path.spec.ts). The OpenList base
 * URL and scoped key are exported via process.env so worker processes can
 * fill the settings form with them.
 */
import path from "node:path";
import { ensureBinary, bootOpenList, type Harness } from "@/__tests__/harness/openlist-bin";
import {
  startStaticSite,
  startUnconfiguredStaticSite,
  startTlsStaticSite,
  type StaticSite,
} from "@/__tests__/harness/next-app";
import { startPrefixProxy, type PrefixProxy } from "@/__tests__/harness/prefix-proxy";

let ol: Harness;
let site: StaticSite;
let unconfigured: StaticSite;
let basepath: StaticSite;
let tls: StaticSite | null = null;
let olProxy: PrefixProxy | null = null;

export default async function globalSetup() {
  await ensureBinary();
  ol = await bootOpenList();

  // A prefix-stripping reverse proxy in front of the same OpenList (the
  // Caddy handle_path / nginx-proxy_pass-with-slash shape): the sub-path
  // e2e drives the whole share journey through /openlist.
  const olPort = Number(new URL(ol.baseUrl).port);
  olProxy = await startPrefixProxy({ targetPort: olPort, prefix: "/openlist", port: 3141 });

  // Each variant serves its own snapshot of out/ (out-unconfigured/,
  // out-configured/, out-basepath/), so the order of these builds doesn't
  // matter — every build rewrites out/ in place.
  unconfigured = await startUnconfiguredStaticSite({ port: 3138 });
  site = await startStaticSite({ openlistBaseUrl: ol.baseUrl, apiKey: ol.apiKey, port: 3137 });
  basepath = await startStaticSite({
    openlistBaseUrl: ol.baseUrl,
    apiKey: ol.apiKey,
    port: 3139,
    basePath: "/pshare",
  });
  // The same unconfigured bundle over TLS (self-signed cert; Playwright loads
  // it with ignoreHTTPSErrors): a secure https:// page context for the
  // mixed-content spec — https page + http:// OpenList is the deployment
  // shape browsers block.
  const root = path.resolve(__dirname, "../../..");
  tls = await startTlsStaticSite(path.join(root, "out-unconfigured"), 3140);

  (globalThis as unknown as {
    __e2eOl: Harness;
    __e2eSite: StaticSite;
    __e2eUnconfigured: StaticSite;
    __e2eBasepath: StaticSite;
    __e2eTls: StaticSite | null;
    __e2eOlProxy: PrefixProxy | null;
  }).__e2eOl = ol;
  (globalThis as unknown as { __e2eSite: StaticSite }).__e2eSite = site;
  (globalThis as unknown as { __e2eUnconfigured: StaticSite }).__e2eUnconfigured = unconfigured;
  (globalThis as unknown as { __e2eBasepath: StaticSite }).__e2eBasepath = basepath;
  (globalThis as unknown as { __e2eTls: StaticSite | null }).__e2eTls = tls;
  (globalThis as unknown as { __e2eOlProxy: PrefixProxy | null }).__e2eOlProxy = olProxy;
  process.env.PSHARE_E2E_URL = site.baseUrl;
  process.env.PSHARE_E2E_UNCONFIGURED_URL = unconfigured.baseUrl;
  process.env.PSHARE_E2E_BASEPATH_URL = basepath.baseUrl;
  process.env.PSHARE_E2E_OL_URL = ol.baseUrl;
  process.env.PSHARE_E2E_OL_KEY = ol.apiKey;
  if (tls) process.env.PSHARE_E2E_TLS_URL = tls.baseUrl;
  if (olProxy) process.env.PSHARE_E2E_OL_PROXY_URL = olProxy.baseUrl;

  // eslint-disable-next-line no-console
  console.log(
    `e2e ready: site=${site.baseUrl} unconfigured=${unconfigured.baseUrl} basepath=${basepath.baseUrl} tls=${tls.baseUrl} olproxy=${olProxy.baseUrl} openlist=${ol.baseUrl}`,
  );
}
