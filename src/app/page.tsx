"use client";

import { useState, useCallback, useEffect } from "react";
import { EXPIRY_PRESETS, formatBytes, detectType, generateId, sanitizeName } from "@/lib/share-utils";
import { OpenListClient, OpenListError } from "@/lib/openlist-client";
import {
  loadBuildConfig,
  loadConfig,
  saveRuntimeConnection,
  clearRuntimeConnection,
  hasRuntimeConnection,
  type Config,
} from "@/lib/config";

type CreateResp = {
  id: string;
  url: string;
  type: string;
  name: string;
  size: number;
  ttl: number;
};

type Tab = "text" | "file";

export default function Home() {
  // Seed with the build-time config so the first client render matches the
  // prerendered HTML exactly; any connection saved in this browser is merged
  // in after mount (reading localStorage during the hydration render would
  // desync from the prerendered output).
  const [cfg, setCfg] = useState<Config>(loadBuildConfig);
  const configured = cfg.openlistBaseUrl !== "" && cfg.openlistApiKey !== "";
  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [ttl, setTtl] = useState<number>(EXPIRY_PRESETS[0].seconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResp | null>(null);

  useEffect(() => {
    setCfg(loadConfig());
  }, []);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (!configured) {
        throw new Error("pshare is not configured (missing OpenList base URL / API key).");
      }
      const client = new OpenListClient(cfg);
      const id = generateId();
      let name: string;
      let mime: string;
      let body: BodyInit;
      let size: number;
      let isText = false;

      if (tab === "text") {
        if (!text.trim()) throw new Error("please enter some text");
        if (Buffer.byteLength) {
          // Node (tests): Buffer exists. Browser: fall back to TextEncoder.
          if (Buffer.byteLength(text, "utf8") > cfg.maxBytes) throw new Error("text too large");
        } else if (new TextEncoder().encode(text).length > cfg.maxBytes) {
          throw new Error("text too large");
        }
        const blob = new Blob([text], { type: "text/plain" });
        name = sanitizeName("paste.txt");
        mime = "text/plain";
        body = blob;
        size = blob.size;
        isText = true;
      } else {
        if (!file) throw new Error("please choose a file");
        if (file.size > cfg.maxBytes) throw new Error("file too large");
        name = sanitizeName(file.name);
        mime = file.type || "application/octet-stream";
        body = file;
        size = file.size;
      }

      const type = detectType(mime, name, isText);
      const path = `${cfg.openlistMountPath}/${id}/${name}`;

      // Upload directly to OpenList from the browser. ttl=0 means "use the
      // OpenList user's default TTL"; a positive value sets a per-file TTL
      // via the X-Ttl header.
      await client.upload(path, body, size, ttl);

      setResult({
        id,
        url: `/s?id=${id}&name=${encodeURIComponent(name)}`,
        type,
        name,
        size,
        ttl,
      });
    } catch (e) {
      if (e instanceof OpenListError) {
        setError(`upload failed: ${e.message} (code ${e.code})`);
      } else if (e instanceof TypeError) {
        // A fetch TypeError is a network or CORS failure. A rejected API key
        // can also land here: OpenList's auth middleware aborts before its
        // CORS middleware runs, so the browser hides the 401 response and
        // fetch rejects with a generic "Failed to fetch".
        setError(
          "upload failed: could not reach OpenList — check the URL, that the backend is running, and that the API key is valid",
        );
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }, [tab, text, file, ttl, cfg, configured]);

  return (
    <main className="container">
      <header className="hero">
        <h1>pshare</h1>
        <p className="tagline">Share temporary text, files, images, video &amp; audio. No login.</p>
      </header>

      {!configured && (
        <div className="error">
          pshare is not configured. Enter the OpenList URL and API key below — they are
          saved in this browser — or bake them in at build time with the
          NEXT_PUBLIC_* environment variables.
        </div>
      )}

      <ConnectionSettings cfg={cfg} onConfigChange={() => setCfg(loadConfig())} />

      <section className="card">
        <div className="tabs">
          <button
            className={tab === "text" ? "tab active" : "tab"}
            onClick={() => setTab("text")}
          >
            Text
          </button>
          <button
            className={tab === "file" ? "tab active" : "tab"}
            onClick={() => setTab("file")}
          >
            File
          </button>
        </div>

        {tab === "text" ? (
          <textarea
            className="text-input"
            placeholder="Paste anything…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
          />
        ) : (
          <div className="file-input">
            <input
              type="file"
              id="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <label htmlFor="file">
              {file ? file.name : "Choose a file (image, video, audio, or any file)"}
            </label>
            {file && (
              <div className="file-meta">
                {file.type || "unknown type"} · {formatBytes(file.size)}
              </div>
            )}
          </div>
        )}

        <div className="options">
          <label>
            Expires after
            <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              {EXPIRY_PRESETS.map((p) => (
                <option key={p.label} value={p.seconds}>
                  {p.label === "default" ? `default (${cfg.defaultTtlLabel})` : p.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button className="primary" onClick={submit} disabled={busy || !configured}>
          {busy ? "Uploading…" : "Create share"}
        </button>

        {error && <div className="error">{error}</div>}

        {result && <ShareResult result={result} />}
      </section>

      <footer className="footer">
        <p>
          Files are stored via OpenList and auto-deleted when they expire. The
          API key is scope-limited (upload / read / delete only, no listing),
          whether baked in at build time or saved here at runtime.
        </p>
      </footer>
    </main>
  );
}

/**
 * Runtime connection settings: point this browser at an OpenList backend
 * without a rebuild. Saved to localStorage and layered over the build-time
 * config (see src/lib/config.ts). Also offers a live "test connection"
 * probe (fs/get on the mount path) so mis-typed URLs / keys are caught
 * before saving.
 */
function ConnectionSettings({
  cfg,
  onConfigChange,
}: {
  cfg: Config;
  onConfigChange: () => void;
}) {
  const [open, setOpen] = useState(cfg.openlistBaseUrl === "" || cfg.openlistApiKey === "");
  const [baseUrl, setBaseUrl] = useState(cfg.openlistBaseUrl);
  const [apiKey, setApiKey] = useState(cfg.openlistApiKey);
  const [savedInBrowser, setSavedInBrowser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Whether an override is stored is only knowable after mount — the
  // prerendered HTML cannot see localStorage.
  useEffect(() => {
    setSavedInBrowser(hasRuntimeConnection());
  }, []);

  // The parent merges any saved runtime connection into cfg after mount;
  // follow it so the fields show the connection actually in effect (the one
  // just saved, or the saved one on a later visit), not the build-time one.
  // cfg only changes after save / clear, which reset these fields anyway.
  useEffect(() => {
    setBaseUrl(cfg.openlistBaseUrl);
    setApiKey(cfg.openlistApiKey);
  }, [cfg.openlistBaseUrl, cfg.openlistApiKey]);

  const trimmed = () => ({
    base: baseUrl.trim().replace(/\/+$/, ""),
    key: apiKey.trim(),
  });

  const save = () => {
    const { base, key } = trimmed();
    if (!base || !key) {
      setMessage({ ok: false, text: "Enter both the OpenList URL and the API key." });
      return;
    }
    const persisted = saveRuntimeConnection(base, key);
    setSavedInBrowser(persisted && hasRuntimeConnection());
    onConfigChange();
    setMessage(
      persisted
        ? { ok: true, text: "Saved — this browser will use this connection." }
        : {
            ok: false,
            text: "Applied for this visit, but saving failed (browser storage unavailable).",
          },
    );
  };

  const test = async () => {
    const { base, key } = trimmed();
    if (!base || !key) {
      setMessage({ ok: false, text: "Enter both the OpenList URL and the API key." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      // Probe with the same call the share view uses: fs/get on the mount
      // path. It checks everything pshare needs in one round-trip — the
      // URL is reachable, the key is accepted (401 otherwise), the key has
      // the fs.get scope, and the mount exists.
      await new OpenListClient({ openlistBaseUrl: base, openlistApiKey: key }).get(
        cfg.openlistMountPath,
      );
      setMessage({ ok: true, text: `Connected — ${base} accepted the API key.` });
    } catch (e) {
      let text: string;
      if (e instanceof OpenListError) {
        if (e.code === 401) {
          text = `Failed: the API key was rejected by ${base}.`;
        } else if (/object not found|no such/i.test(e.message)) {
          text = `The key works, but ${cfg.openlistMountPath} was not found on ${base} — shares cannot be stored there.`;
        } else {
          text = `Failed: ${e.message} (code ${e.code}).`;
        }
      } else {
        // A fetch TypeError covers unreachable URLs, down backends, and —
        // because OpenList's auth middleware aborts before its CORS
        // middleware runs — rejected keys, whose 401 the browser hides as
        // a generic network error.
        text = `Failed: could not reach ${base} — the URL may be wrong, OpenList may be down, or the API key may have been rejected.`;
      }
      setMessage({ ok: false, text });
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    clearRuntimeConnection();
    setSavedInBrowser(false);
    const build = loadBuildConfig();
    setBaseUrl(build.openlistBaseUrl);
    setApiKey(build.openlistApiKey);
    onConfigChange();
    setMessage({ ok: true, text: "Cleared — using the build-time configuration." });
  };

  return (
    <div className="connection">
      <button className="connection-toggle" onClick={() => setOpen(!open)}>
        OpenList connection · {cfg.openlistBaseUrl || "not set"}
      </button>
      {open && (
        <div className="connection-panel">
          <label>
            OpenList URL
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://ol.example.com"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="scoped key (fs.put / fs.get / fs.rm)"
              autoComplete="off"
            />
          </label>
          <div className="connection-actions">
            <button className="primary" onClick={save}>
              Save
            </button>
            <button onClick={test} disabled={busy}>
              {busy ? "Testing…" : "Test connection"}
            </button>
            {savedInBrowser && (
              <button className="danger" onClick={clear}>
                Clear saved settings
              </button>
            )}
          </div>
          {message && <div className={message.ok ? "notice-ok" : "error"}>{message.text}</div>}
          <p className="muted connection-note">
            Saved settings live in this browser only (localStorage). For an instance used
            by many people, bake the URL and key in at build time instead. The API key
            needs the fs.put / fs.get / fs.rm scopes and listing disabled.
          </p>
        </div>
      )}
    </div>
  );
}

function ShareResult({ result }: { result: CreateResp }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}${result.url}`;
  const copy = () => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="result">
      <div className="result-url">
        <input readOnly value={url} onFocus={(e) => e.target.select()} />
        <button onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
        <a className="open" href={result.url} target="_blank" rel="noreferrer">
          Open
        </a>
      </div>
      <div className="result-meta">
        {result.type} · {formatBytes(result.size)}
      </div>
    </div>
  );
}
