"use client";

import { useState, useCallback } from "react";
import { EXPIRY_PRESETS, DOWNLOAD_LIMIT_PRESETS, formatBytes } from "@/lib/share-utils";

type CreateResp = {
  id: string;
  url: string;
  type: string;
  name: string;
  size: number;
  expires_at: number;
  max_downloads: number;
};

type Tab = "text" | "file";

export default function Home() {
  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [ttl, setTtl] = useState<number>(EXPIRY_PRESETS[1].seconds);
  const [maxDownloads, setMaxDownloads] = useState<number>(DOWNLOAD_LIMIT_PRESETS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResp | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let resp: Response;
      if (tab === "text") {
        if (!text.trim()) throw new Error("please enter some text");
        resp = await fetch("/api/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, ttl, maxDownloads }),
        });
      } else {
        if (!file) throw new Error("please choose a file");
        const form = new FormData();
        form.append("file", file);
        form.append("ttl", String(ttl));
        form.append("maxDownloads", String(maxDownloads));
        resp = await fetch("/api/share", { method: "POST", body: form });
      }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "upload failed");
      setResult(data as CreateResp);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [tab, text, file, ttl, maxDownloads]);

  return (
    <main className="container">
      <header className="hero">
        <h1>pshare</h1>
        <p className="tagline">Share temporary text, files, images, video &amp; audio. No login.</p>
      </header>

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
                <option key={p.seconds} value={p.seconds}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Max downloads
            <select
              value={maxDownloads}
              onChange={(e) => setMaxDownloads(Number(e.target.value))}
            >
              {DOWNLOAD_LIMIT_PRESETS.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "unlimited" : n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? "Uploading…" : "Create share"}
        </button>

        {error && <div className="error">{error}</div>}

        {result && <ShareResult result={result} />}
      </section>

      <footer className="footer">
        <p>
          Files are stored via OpenList and auto-deleted when they expire or hit
          their download limit.
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
        {result.type} · {formatBytes(result.size)} · expires{" "}
        {new Date(result.expires_at).toLocaleString()}
        {result.max_downloads > 0 && ` · max ${result.max_downloads} downloads`}
      </div>
    </div>
  );
}
