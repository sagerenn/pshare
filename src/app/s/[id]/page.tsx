"use client";

import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/share-utils";

type ShareData = {
  id: string;
  type: "text" | "file" | "image" | "video" | "audio";
  name: string;
  mime: string;
  size: number;
  expires_at: number;
  max_downloads: number;
  downloads: number;
  download_url: string;
};

type State =
  | { kind: "loading" }
  | { kind: "ok"; data: ShareData }
  | { kind: "error"; status: number; message: string };

export default function ShareView({ params }: { params: { id: string } }) {
  const id = params.id;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [textContent, setTextContent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/share/${id}`)
      .then(async (r) => {
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setState({ kind: "error", status: r.status, message: body.error || "failed" });
          return;
        }
        setState({ kind: "ok", data: body as ShareData });
      })
      .catch(() => !cancelled && setState({ kind: "error", status: 0, message: "network error" }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  // For text shares, fetch the content from the signed download URL.
  const okData = state.kind === "ok" ? state.data : null;
  useEffect(() => {
    if (!okData || okData.type !== "text" || !okData.download_url) return;
    let cancelled = false;
    fetch(okData.download_url)
      .then((r) => r.text())
      .then((t) => !cancelled && setTextContent(t))
      .catch(() => !cancelled && setTextContent("(failed to load text)"));
    return () => {
      cancelled = true;
    };
  }, [okData?.id, okData?.download_url]);

  if (state.kind === "loading") {
    return (
      <main className="container">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (state.kind === "error") {
    const msg =
      state.status === 404
        ? "This share doesn't exist."
        : state.status === 410
          ? "This share has expired or reached its download limit."
          : state.message;
    return (
      <main className="container">
        <div className="card">
          <h2>Unavailable</h2>
          <p className="muted">{msg}</p>
        </div>
      </main>
    );
  }

  const d = state.data;
  return (
    <main className="container">
      <header className="hero">
        <h1>pshare</h1>
        <p className="tagline">{d.name}</p>
      </header>
      <section className="card">
        <Viewer data={d} textContent={textContent} />
        <div className="result-meta">
          {d.type} · {formatBytes(d.size)} · expires{" "}
          {new Date(d.expires_at).toLocaleString()}
          {d.max_downloads > 0 &&
            ` · ${Math.max(0, d.max_downloads - d.downloads)} downloads left`}
        </div>
        <a className="primary download-btn" href={d.download_url} download={d.name}>
          Download
        </a>
      </section>
    </main>
  );
}

function Viewer({ data, textContent }: { data: ShareData; textContent: string | null }) {
  switch (data.type) {
    case "text":
      return (
        <pre className="text-view">
          {textContent === null ? "Loading…" : textContent}
        </pre>
      );
    case "image":
      return <img className="media" src={data.download_url} alt={data.name} />;
    case "video":
      return <video className="media" src={data.download_url} controls />;
    case "audio":
      return <audio className="media" src={data.download_url} controls />;
    default:
      return (
        <div className="file-view">
          <p className="muted">A file is ready to download.</p>
        </div>
      );
  }
}
