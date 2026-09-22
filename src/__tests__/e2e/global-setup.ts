/**
 * Playwright global setup: build (if needed) and boot a real openlist-ext
 * binary, then start the Next.js pshare server pointed at it. The app URL is
 * stashed on process.env and in a temp file so the teardown (a separate
 * process) can find and kill the servers.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureBinary, bootOpenList, type Harness } from "@/__tests__/harness/openlist-bin";
import { startNextApp, type NextApp } from "@/__tests__/harness/next-app";

let ol: Harness;
let app: NextApp;

export default async function globalSetup() {
  await ensureBinary();
  ol = await bootOpenList();
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "pshare-e2e-")), "pshare.db");
  app = await startNextApp({ openlistBaseUrl: ol.baseUrl, dbPath, port: 3137 });

  // Stash handles for the teardown process via a temp file holding the pids
  // is fragile; instead we keep them alive on the module and rely on
  // globalTeardown being called in the same process.
  (globalThis as unknown as { __e2eOl: Harness; __e2eApp: NextApp }).__e2eOl = ol;
  (globalThis as unknown as { __e2eOl: Harness; __e2eApp: NextApp }).__e2eApp = app;
  process.env.PSHARE_E2E_URL = app.baseUrl;

  // eslint-disable-next-line no-console
  console.log(`e2e ready: app=${app.baseUrl} openlist=${ol.baseUrl}`);
}
