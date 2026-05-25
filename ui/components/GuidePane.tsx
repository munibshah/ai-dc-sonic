"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
              className="text-sky-300 hover:text-sky-200 underline decoration-sky-500/40"
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
          // react-markdown v10 dropped the `inline` prop. The reliable
          // discriminator is structural: fenced code blocks come through
          // as <pre><code>, inline backticks come through as bare <code>.
          // We intercept <pre> to render our CodeBlock; the <code> override
          // then only fires for inline cases.
          pre: ({ node }: any) => {
            const codeNode = node?.children?.find((c: any) => c.tagName === "code") ?? node?.children?.[0];
            const value = extractCodeText(codeNode).replace(/\n$/, "");
            return <CodeBlock value={value} />;
          },
          code: ({ children }: any) => (
            <code className="px-1 py-0.5 rounded bg-slate-700/40 text-sky-200/90 font-mono text-[0.88em]">
              {children}
            </code>
          ),
        }}
      >
        {md}
      </ReactMarkdown>
    </article>
  );
}

function extractCodeText(node: any): string {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  if (Array.isArray(node.children)) return node.children.map(extractCodeText).join("");
  return "";
}

function CodeBlock({ value }: { value: string }) {
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
      <pre className="m-0 px-4 py-3 rounded-lg bg-[#0b0f1a] border border-white/10 overflow-x-auto">
        <code className="font-mono text-[0.85em] leading-relaxed text-slate-100 whitespace-pre">
          {value}
        </code>
      </pre>
    </div>
  );
}
