"use client";

import { useEffect, useState } from "react";
import { formatBytes, detectType } from "@/lib/share-utils";
import { OpenListClient, OpenListError, type FileInfo } from "@/lib/openlist-client";
import { loadConfig, isConfigured } from "@/lib/config";

type State =
  | { kind: "loading" }
  | { kind: "ok"; id: string; info: FileInfo; name: string; type: ReturnType<typeof detectType>; rawUrl: string }
  | { kind: "error"; message: string };

/**
 * Static share-view page. pshare is a static export, so the share id and file
 * name are read from the browser's query string (e.g.
 * /s?id=abc123&name=paste.txt) in a useEffect, rather than from a dynamic
 * route segment or the searchParams prop (which would force dynamic
 * rendering and break `output: "export"`). The page fetches the file info
 * from OpenList in the browser and renders the appropriate viewer.
 */
export default function ShareView() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [textContent, setTextContent] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id") ?? "";
    const name = params.get("name") ?? "";

    if (!isConfigured()) {
      setState({ kind: "error", message: "pshare is not configured." });
      return;
    }
    if (!id || !name) {
      setState({ kind: "error", message: "Missing share id or file name in the link." });
      return;
    }
    let cancelled = false;
    const cfg = loadConfig();
    const client = new OpenListClient(cfg);
    const path = `${cfg.openlistMountPath}/${id}/${name}`;
    client
      .get(path)
      .then((info) => {
        if (cancelled) return;
        const rawUrl = resolveRawUrl(cfg.openlistBaseUrl, info.raw_url);
        const type = detectType(info.provider || "", name, false);
        setState({ kind: "ok", id, info, name, type, rawUrl });
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof OpenListError) {
          // 404 / "object not found" means the file was deleted by TTL or manually.
          const gone = e.code === 404 || /not found|no such/i.test(e.message);
          setState({
            kind: "error",
            message: gone
              ? "This share has expired or been deleted."
              : `Failed to load share: ${e.message} (code ${e.code})`,
          });
        } else {
          setState({ kind: "error", message: (e as Error).message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ok = state.kind === "ok" ? state : null;

  // For text shares, fetch the content from the resolved raw URL.
  useEffect(() => {
    if (!ok || ok.type !== "text" || !ok.rawUrl) return;
    let cancelled = false;
    fetch(ok.rawUrl)
      .then((r) => r.text())
      .then((t) => !cancelled && setTextContent(t))
      .catch(() => !cancelled && setTextContent("(failed to load text)"));
    return () => {
      cancelled = true;
    };
  }, [ok?.rawUrl, ok?.type]);

  if (state.kind === "loading") {
    return (
      <main className="container">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="container">
        <div className="card">
          <h2>Unavailable</h2>
          <p className="muted">{state.message}</p>
        </div>
      </main>
    );
  }

  const { info, type, rawUrl } = state;
  return (
    <main className="container">
      <header className="hero">
        <h1>pshare</h1>
        <p className="tagline">{state.name}</p>
      </header>
      <section className="card">
        <Viewer type={type} rawUrl={rawUrl} name={state.name} textContent={textContent} />
        <div className="result-meta">
          {type} · {formatBytes(info.size)}
        </div>
        <div className="result-url">
          <a className="primary download-btn" href={rawUrl} download={state.name}>
            Download
          </a>
          <DeleteButton id={state.id} name={state.name} />
        </div>
      </section>
    </main>
  );
}

function Viewer({ type, rawUrl, name, textContent }: {
  type: ReturnType<typeof detectType>;
  rawUrl: string;
  name: string;
  textContent: string | null;
}) {
  switch (type) {
    case "text":
      return <pre className="text-view">{textContent === null ? "Loading…" : textContent}</pre>;
    case "image":
      return <img className="media" src={rawUrl} alt={name} />;
    case "video":
      return <video className="media" src={rawUrl} controls />;
    case "audio":
      return <audio className="media" src={rawUrl} controls />;
    default:
      return (
        <div className="file-view">
          <p className="muted">A file is ready to download.</p>
        </div>
      );
  }
}

function DeleteButton({ id, name }: { id: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const del = async () => {
    setBusy(true);
    setErr(null);
    try {
      const cfg = loadConfig();
      const client = new OpenListClient(cfg);
      await client.remove(`${cfg.openlistMountPath}/${id}`, [name]);
      setDone(true);
    } catch (e) {
      setErr(e instanceof OpenListError ? `${e.message} (code ${e.code})` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) return <span className="muted">Deleted.</span>;
  return (
    <>
      <button className="danger" onClick={del} disabled={busy}>
        {busy ? "Deleting…" : "Delete"}
      </button>
      {err && <span className="error">{err}</span>}
    </>
  );
}

/**
 * OpenList's `raw_url` may be a relative proxied path (e.g. `/p/...?sign=...`)
 * or an absolute pre-signed storage URL. Relative paths must be resolved
 * against the OpenList base URL; absolute URLs are used as-is.
 */
function resolveRawUrl(base: string, raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${base.replace(/\/+$/, "")}${raw.startsWith("/") ? raw : `/${raw}`}`;
}
