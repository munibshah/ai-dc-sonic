"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { API_BASE } from "@/lib/api";

interface Props {
  labId: string;
  part?: "exercise" | "solution" | "overview";
}

export default function GuidePane({ labId, part = "exercise" }: Props) {
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setMd(null);
    setError(null);
    fetch(`${API_BASE}/api/labs/${labId}/content/${part}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => alive && setMd(t))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [labId, part]);

  if (error)
    return (
      <div className="p-4 rounded border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm">
        Failed to load guide: {error}
      </div>
    );
  if (md === null)
    return <div className="p-4 text-white/50 text-sm">Loading guide…</div>;

  return (
    <article className="prose-guide max-w-none px-6 py-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-2xl font-semibold mt-6 mb-3 text-white">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-semibold mt-8 mb-3 text-white border-b border-white/10 pb-2">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold mt-6 mb-2 text-white/90">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="text-white/80 leading-relaxed my-3">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-outside ml-6 my-3 space-y-1 text-white/80">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-outside ml-6 my-3 space-y-1 text-white/80">{children}</ol>
          ),
          li: ({ children }) => <li className="text-white/80">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-amber-300 hover:text-amber-200 underline decoration-amber-500/40"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-4 pl-4 border-l-4 border-amber-400/60 bg-amber-400/5 py-2 pr-3 rounded-r text-white/85">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className="text-sm border-collapse text-white/85">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-white/5">{children}</thead>,
          th: ({ children }) => (
            <th className="border border-white/15 px-3 py-1.5 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-white/10 px-3 py-1.5 align-top">{children}</td>
          ),
          hr: () => <hr className="my-6 border-white/10" />,
          code: ({ inline, className, children, ...props }: any) => {
            const match = /language-(\w+)/.exec(className || "");
            const codeText = String(children).replace(/\n$/, "");
            if (inline) {
              return (
                <code className="px-1.5 py-0.5 rounded bg-white/10 text-amber-200 font-mono text-[0.9em]">
                  {children}
                </code>
              );
            }
            return (
              <CodeBlock language={match?.[1] ?? "text"} value={codeText} />
            );
          },
        }}
      >
        {md}
      </ReactMarkdown>
    </article>
  );
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="relative my-3 group">
      <button
        onClick={copy}
        className="absolute top-2 right-2 z-10 text-[10px] uppercase tracking-wider px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white/80 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {copied ? "copied" : "copy"}
      </button>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: "0.9rem 1rem",
          fontSize: "0.85rem",
          borderRadius: "0.5rem",
          background: "#0b0f1a",
        }}
        wrapLongLines={false}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  );
}
