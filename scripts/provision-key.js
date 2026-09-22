#!/usr/bin/env node
/**
 * provision-key.js — mint a scoped OpenList API key for pshare's static site.
 *
 * pshare has no backend; the browser talks to OpenList directly with a
 * non-admin user's API key. This helper uses the OpenList admin API to:
 *   1. (optional) create a non-admin user with write+remove permissions,
 *   2. look up that user's id,
 *   3. disable listing (CanList=false) and enable TTL for the user,
 *   4. create an API key scoped to fs.put / fs.get / fs.rm,
 *   5. print the build-time env vars to paste into your build config.
 *
 * Usage:
 *   node scripts/provision-key.js \
 *     --base https://ol.example.com \
 *     --admin-token <admin-jwt-or-extension-token> \
 *     --username pshare \
 *     --password <password>            # omit to skip user creation
 *     --mount /pshare                  # default /pshare
 *
 * Requires Node 18+ (global fetch). No dependencies.
 */
"use strict";

const args = parseArgs(process.argv.slice(2));
const {
  base = "",
  adminToken = "",
  username = "pshare",
  password = "",
  mount = "/pshare",
} = args;

if (!base || !adminToken) {
  console.error("Usage: provision-key.js --base <url> --admin-token <tok> [--username pshare] [--password <pw>] [--mount /pshare]");
  process.exit(1);
}

const API = base.replace(/\/+$/, "");
const auth = { Authorization: adminToken, "Content-Type": "application/json" };

async function ol(path, body) {
  const init = body
    ? { method: "POST", headers: auth, body: JSON.stringify(body) }
    : { method: "GET", headers: { Authorization: adminToken } };
  const r = await fetch(`${API}${path}`, init);
  const j = (await r.json().catch(() => ({})));
  if (j.code !== 200) throw new Error(`${path} failed: ${j.message || r.status}`);
  return j.data;
}

// Permission bitfield (OpenList core): bit 3 = CanWriteContent, bit 7 = CanRemove.
// No list bit exists in core; listing is gated by the extension's CanList flag.
const PERM_WRITE = 1 << 3;
const PERM_REMOVE = 1 << 7;

(async () => {
  let userId;

  if (password) {
    // 1. Create the non-admin user (core OpenList admin API).
    console.log(`creating user "${username}"…`);
    try {
      await ol("/api/admin/user/create", {
        username,
        password,
        permission: PERM_WRITE | PERM_REMOVE,
        base_path: mount,
        disabled: false,
      });
    } catch (e) {
      if (/exist|duplicate|already/i.test(e.message)) {
        console.log(`user "${username}" already exists, continuing.`);
      } else {
        throw e;
      }
    }
  } else {
    console.log("no --password given; assuming user already exists.");
  }

  // 2. Look up the user id.
  const users = await ol("/api/admin/user/list");
  const found = (users?.list ?? users ?? []).find(
    (u) => (u.username || u.user_name) === username,
  );
  if (!found) throw new Error(`user "${username}" not found after create/list.`);
  userId = found.id;
  console.log(`user id: ${userId}`);

  // 3. Disable listing and enable TTL via the extension admin API.
  console.log("disabling list permission (CanList=false)…");
  await extPut(`/ext/admin/listperm/${userId}`, { can_list: false, can_read: true });

  console.log("enabling TTL (fixed, 1 day default)…");
  await extPut(`/ext/admin/ttl/${userId}`, {
    enabled: true,
    mode: "fixed",
    duration_seconds: 86400,
  });

  // 4. Create the scoped API key.
  console.log("creating scoped API key (fs.put, fs.get, fs.rm)…");
  const key = await ol("/ext/admin/apikey", {
    user_id: userId,
    name: "pshare-static",
    scopes: ["fs.put", "fs.get", "fs.rm"],
  });
  const secret = key?.secret;
  if (!secret) throw new Error(`apikey response had no secret: ${JSON.stringify(key)}`);

  // 5. Print the build-time env vars.
  console.log("\n✅ Provisioned. Set these at build time:\n");
  console.log(`NEXT_PUBLIC_OPENLIST_BASE_URL=${API}`);
  console.log(`NEXT_PUBLIC_OPENLIST_API_KEY=${secret}`);
  console.log(`NEXT_PUBLIC_OPENLIST_MOUNT_PATH=${mount}`);
  console.log(`NEXT_PUBLIC_PSHARE_DEFAULT_TTL=86400`);
  console.log(`NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL="1 day"`);
})().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});

async function extPut(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: "PUT",
    headers: auth,
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({})));
  if (j.code !== 200) throw new Error(`${path} failed: ${j.message || r.status}`);
  return j.data;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}
