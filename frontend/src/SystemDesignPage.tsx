import { useMemo, useState } from "react";
import styles from "./App.module.css";
import systemDesignMd from "./SYSTEM_DESIGN.md?raw";

// Tiny markdown renderer covering exactly what this doc uses:
// # / ## / ### headings, paragraphs, fenced code blocks, GFM tables,
// `- ` lists, `---` horizontal rules, `> ` blockquotes, plus inline
// **bold**, *italic*, `code`, and [text](url) links.
// Intentionally not a full parser — keeps the bundle small and lets us
// hand-tune the styling for this page.

type Block =
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; lang: string; body: string }
  | { kind: "hr" }
  | { kind: "blockquote"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

function parseBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      out.push({ kind: "code", lang, body: body.join("\n") });
      continue;
    }

    // Horizontal rule
    if (/^-{3,}\s*$/.test(line)) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      out.push({ kind: "h", level: h[1].length as 1 | 2 | 3, text: h[2] });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const buf: string[] = [line.slice(2)];
      i++;
      while (i < lines.length && lines[i].startsWith("> ")) {
        buf.push(lines[i].slice(2));
        i++;
      }
      out.push({ kind: "blockquote", text: buf.join(" ") });
      continue;
    }

    // Tables: a `| ... |` line followed by a `| --- | --- |` separator
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const splitRow = (row: string) =>
        row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      const headers = splitRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push({ kind: "table", headers, rows });
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      out.push({ kind: "ul", items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push({ kind: "ol", items });
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: accumulate consecutive non-special lines
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("> ") &&
      !/^-{3,}\s*$/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith("|")
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ kind: "p", text: buf.join(" ") });
  }

  return out;
}

// Renders inline markdown: `code`, **bold**, *italic*, [text](url).
// Processed in that order so a `**` inside a code span stays literal.
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Tokenize on backticks first to protect code spans.
  const codeChunks = text.split(/(`[^`]+`)/g);
  codeChunks.forEach((chunk, ci) => {
    if (chunk.startsWith("`") && chunk.endsWith("`") && chunk.length >= 2) {
      parts.push(
        <code key={`c-${ci}`} style={{
          background: "var(--surface, #f3f4f6)", padding: "0.1rem 0.45rem",
          borderRadius: "0.4rem", fontSize: "0.95em", fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        }}>
          {chunk.slice(1, -1)}
        </code>
      );
      return;
    }
    // Within non-code chunks, walk a regex that matches bold/italic/link in order.
    const pattern = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(chunk)) !== null) {
      if (m.index > last) parts.push(chunk.slice(last, m.index));
      const token = m[0];
      if (token.startsWith("**")) {
        parts.push(<strong key={`b-${ci}-${m.index}`}>{token.slice(2, -2)}</strong>);
      } else if (token.startsWith("*")) {
        parts.push(<em key={`i-${ci}-${m.index}`}>{token.slice(1, -1)}</em>);
      } else {
        const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          parts.push(
            <a key={`a-${ci}-${m.index}`} href={linkMatch[2]} target="_blank" rel="noopener noreferrer"
               style={{ color: "var(--brand)", fontWeight: 600 }}>
              {linkMatch[1]}
            </a>
          );
        }
      }
      last = m.index + token.length;
    }
    if (last < chunk.length) parts.push(chunk.slice(last));
  });
  return parts;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const headingStyles = {
  h1: { fontSize: "3rem", fontWeight: 800, marginTop: "0", marginBottom: "1.6rem", color: "var(--ink)", lineHeight: 1.2 },
  h2: { fontSize: "2.2rem", fontWeight: 800, marginTop: "4rem", marginBottom: "1.2rem", color: "var(--ink)", lineHeight: 1.25, paddingBottom: "0.6rem", borderBottom: "1px solid var(--border)" },
  h3: { fontSize: "1.7rem", fontWeight: 700, marginTop: "2.4rem", marginBottom: "0.8rem", color: "var(--ink)" },
} as const;

const RenderedBlock = ({ block }: { block: Block }) => {
  switch (block.kind) {
    case "h": {
      const Tag = (`h${block.level}` as "h1" | "h2" | "h3");
      const style = headingStyles[Tag];
      const id = slugify(block.text);
      return <Tag id={id} style={style}>{renderInline(block.text)}</Tag>;
    }
    case "p":
      return (
        <p style={{ fontSize: "1.5rem", lineHeight: 1.75, color: "var(--ink-2)", marginBottom: "1.4rem" }}>
          {renderInline(block.text)}
        </p>
      );
    case "ul":
      return (
        <ul style={{ marginBottom: "1.6rem", paddingLeft: "2.2rem", fontSize: "1.45rem", lineHeight: 1.8, color: "var(--ink-2)" }}>
          {block.items.map((item, idx) => <li key={idx}>{renderInline(item)}</li>)}
        </ul>
      );
    case "ol":
      return (
        <ol style={{ marginBottom: "1.6rem", paddingLeft: "2.2rem", fontSize: "1.45rem", lineHeight: 1.8, color: "var(--ink-2)" }}>
          {block.items.map((item, idx) => <li key={idx}>{renderInline(item)}</li>)}
        </ol>
      );
    case "code":
      return (
        <pre style={{
          background: "#0f172a", color: "#e2e8f0",
          padding: "1.6rem 1.8rem", borderRadius: "0.8rem",
          overflowX: "auto", marginBottom: "1.8rem",
          fontSize: "1.25rem", lineHeight: 1.6,
          fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        }}>
          <code>{block.body}</code>
        </pre>
      );
    case "hr":
      return <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "3rem 0" }} />;
    case "blockquote":
      return (
        <blockquote style={{
          borderLeft: "4px solid var(--brand)",
          paddingLeft: "1.4rem", marginBottom: "1.8rem",
          color: "var(--muted)", fontStyle: "italic", fontSize: "1.45rem", lineHeight: 1.7,
        }}>
          {renderInline(block.text)}
        </blockquote>
      );
    case "table":
      return (
        <div style={{ overflowX: "auto", marginBottom: "1.8rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "1.35rem" }}>
            <thead>
              <tr>
                {block.headers.map((h, idx) => (
                  <th key={idx} style={{
                    textAlign: "left", padding: "0.9rem 1rem",
                    borderBottom: "2px solid var(--border)",
                    background: "var(--surface, #f9fafb)",
                    fontWeight: 700, color: "var(--ink)",
                  }}>
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{
                      padding: "0.8rem 1rem",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--ink-2)", verticalAlign: "top",
                    }}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
};

const SystemDesignPage = () => {
  const [copied, setCopied] = useState<"none" | "md" | "html">("none");
  const blocks = useMemo(() => parseBlocks(systemDesignMd), []);

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(systemDesignMd);
      setCopied("md");
      setTimeout(() => setCopied("none"), 2000);
    } catch {
      setCopied("none");
    }
  };

  const copyRichText = async () => {
    const article = document.getElementById("system-design-content");
    if (!article) return;
    try {
      const html = article.innerHTML;
      const text = article.innerText;
      // Use the modern clipboard API with both HTML and plain text so pastes
      // into Confluence/Notion/Google Docs preserve formatting.
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setCopied("html");
      setTimeout(() => setCopied("none"), 2000);
    } catch {
      setCopied("none");
    }
  };

  return (
    <main className={styles.page} style={{ maxWidth: "90rem", margin: "0 auto", padding: "4rem 2.4rem 8rem" }}>
      <div style={{ marginBottom: "2.4rem" }}>
        <a href="/" style={{ color: "var(--brand)", fontWeight: 600, fontSize: "1.4rem", textDecoration: "none" }}>
          ← Back to Advance
        </a>
      </div>

      <div style={{
        position: "sticky", top: 0, zIndex: 5,
        background: "rgba(255,255,255,0.92)", backdropFilter: "blur(8px)",
        margin: "0 -2.4rem 2.4rem", padding: "1.2rem 2.4rem",
        borderBottom: "1px solid var(--border)",
        display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem",
      }}>
        <p style={{ fontSize: "1.3rem", color: "var(--muted)", margin: 0 }}>
          Engineering reference · paste into Confluence / Notion / Google Docs
        </p>
        <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
          <button
            onClick={copyRichText}
            style={{
              padding: "0.7rem 1.4rem", fontSize: "1.3rem", fontWeight: 600,
              borderRadius: "0.6rem", border: "1.5px solid var(--border)",
              background: "var(--white)", color: "var(--ink)", cursor: "pointer",
            }}
          >
            {copied === "html" ? "✓ Copied!" : "Copy rich text"}
          </button>
          <button
            onClick={copyMarkdown}
            style={{
              padding: "0.7rem 1.4rem", fontSize: "1.3rem", fontWeight: 700,
              borderRadius: "0.6rem", border: "none",
              background: "var(--brand)", color: "white", cursor: "pointer",
            }}
          >
            {copied === "md" ? "✓ Copied!" : "Copy markdown"}
          </button>
        </div>
      </div>

      <article id="system-design-content">
        {blocks.map((block, idx) => (
          <RenderedBlock key={idx} block={block} />
        ))}
      </article>
    </main>
  );
};

export default SystemDesignPage;
