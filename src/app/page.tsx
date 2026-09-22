"use client";

import { useState, useCallback } from "react";
import { EXPIRY_PRESETS, formatBytes, detectType, generateId, sanitizeName } from "@/lib/share-utils";
import { OpenListClient, OpenListError } from "@/lib/openlist-client";
import { loadConfig, isConfigured } from "@/lib/config";

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
  const cfg = loadConfig();
  const configured = isConfigured();
  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [ttl, setTtl] = useState<number>(EXPIRY_PRESETS[0].seconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResp | null>(null);

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
          pshare is not configured. Set NEXT_PUBLIC_OPENLIST_BASE_URL and
          NEXT_PUBLIC_OPENLIST_API_KEY at build time.
        </div>
      )}

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
          API key in the bundle is scope-limited (upload / read / delete only,
          no listing).
        </p>
      </footer>
    </main>
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
