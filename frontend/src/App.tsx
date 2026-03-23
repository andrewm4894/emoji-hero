import { useState, useRef, useEffect, useCallback } from "react";
import { flushSync } from "react-dom";
import { streamChat, getImageUrl, getDownloadUrl, type ChatChunk } from "./api";
import { getDistinctId, trackEvent } from "./posthog";
import "./App.css";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const IMAGE_ID_REGEX = /\b([a-f0-9]{12})\b/g;

function extractImageIds(text: string): string[] {
  const matches = text.match(IMAGE_ID_REGEX);
  if (!matches) return [];
  return [...new Set(matches)];
}

const SUGGESTIONS = [
  "Find me a 'this is fine' meme",
  "I need a thumbs up parrot emoji",
  "Get me a 'LGTM' reaction image",
  "Find a 'mind blown' gif for slack",
];

const THEMES = [
  { id: "dark", name: "Dark", color: "#f59e0b" },
  { id: "light", name: "Light", color: "#3b82f6" },
  { id: "midnight", name: "Midnight", color: "#06b6d4" },
  { id: "sunset", name: "Sunset", color: "#f97316" },
  { id: "forest", name: "Forest", color: "#10b981" },
] as const;

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId] = useState(() => getDistinctId() || crypto.randomUUID());
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
  const [themeOpen, setThemeOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const themeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!themeOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) {
        setThemeOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [themeOpen]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMessage: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsStreaming(true);

    // Add empty assistant message for streaming
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      await streamChat(text, sessionId, (chunk: ChatChunk) => {
        flushSync(() => {
          setMessages((prev) => {
            const updated = prev.slice(0, -1);
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;

            if (chunk.type === "text_delta" && chunk.content) {
              return [...updated, { ...last, content: last.content + chunk.content }];
            } else if (chunk.type === "tool_call") {
              const label = toolLabel(chunk.tool || "tool", chunk.args);
              return [...updated, { ...last, content: last.content + label }];
            } else if (chunk.type === "tool_result") {
              const label = `\n`;
              return [...updated, { ...last, content: last.content + label }];
            }
            return prev;
          });
        });
      });
    } catch (err) {
      setMessages((prev) => {
        const updated = prev.slice(0, -1);
        const last = prev[prev.length - 1];
        if (last.role === "assistant") {
          return [...updated, { ...last, content: "Something went wrong. Please try again." }];
        }
        return prev;
      });
      console.error("Chat error:", err);
    } finally {
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  return (
    <>
      <header className="header">
        <div className="header-glow" />
        <div className="header-inner">
          <div className="header-brand">
            <div className="header-logo">
              <svg viewBox="0 0 128 128" width="36" height="36" aria-hidden="true">
                <defs>
                  <linearGradient id="logo-bg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="var(--accent)" />
                    <stop offset="100%" stopColor="var(--accent-hover)" />
                  </linearGradient>
                </defs>
                <rect width="128" height="128" rx="26" fill="url(#logo-bg)" />
                <rect x="4" y="4" width="120" height="120" rx="22" fill="none" stroke="white" strokeOpacity="0.25" strokeWidth="3" />
                <polygon
                  points="64,18 74.5,47.5 106,47.5 80.5,66 90,96 64,78 38,96 47.5,66 22,47.5 53.5,47.5"
                  fill="white"
                  fillOpacity="0.95"
                />
              </svg>
            </div>
            <div className="header-text">
              <h1 className="header-title">
                <span className="header-title-emoji">Emoji</span>
                {" "}
                <span className="header-title-hero">Hero</span>
              </h1>
              <span className="header-tagline">find & customize emoji for Slack</span>
            </div>
          </div>
          <div className="header-actions">
            <div className="theme-picker" ref={themeRef}>
              <button
                className="theme-toggle"
                onClick={() => setThemeOpen(!themeOpen)}
                aria-label="Change theme"
              >
                <span className="theme-toggle-swatches">
                  {THEMES.slice(0, 5).map((t) => (
                    <span key={t.id} className="theme-toggle-dot" style={{ background: t.color }} />
                  ))}
                </span>
              </button>
              {themeOpen && (
                <div className="theme-dropdown">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      className={`theme-option${theme === t.id ? " active" : ""}`}
                      onClick={() => {
                        setTheme(t.id);
                        setThemeOpen(false);
                        trackEvent("theme_changed", { theme: t.id });
                      }}
                    >
                      <span className="theme-swatch" style={{ background: t.color }} />
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="header-accent-line" />
      </header>

      {messages.length === 0 ? (
        <div className="welcome">
          <div className="welcome-logo">
            <svg viewBox="0 0 128 128" width="56" height="56" aria-hidden="true">
              <defs>
                <linearGradient id="welcome-bg" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="var(--accent)" />
                  <stop offset="100%" stopColor="var(--accent-hover)" />
                </linearGradient>
              </defs>
              <rect width="128" height="128" rx="26" fill="url(#welcome-bg)" />
              <rect x="4" y="4" width="120" height="120" rx="22" fill="none" stroke="white" strokeOpacity="0.25" strokeWidth="3" />
              <polygon
                points="64,18 74.5,47.5 106,47.5 80.5,66 90,96 64,78 38,96 47.5,66 22,47.5 53.5,47.5"
                fill="white"
                fillOpacity="0.95"
              />
            </svg>
          </div>
          <h2>What emoji do you need?</h2>
          <p>
            Tell me what you're looking for and I'll find, customize, and
            optimize it for Slack.
          </p>
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => sendMessage(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="messages">
          {messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role}`}>
              <MessageContent content={msg.content} />
              {msg.role === "assistant" && msg.content && (
                <EmojiPreviews content={msg.content} />
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      <div className="input-area">
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe the emoji you want..."
            disabled={isStreaming}
            autoFocus
          />
          <button type="submit" disabled={isStreaming || !input.trim()}>
            {isStreaming ? "..." : "Send"}
          </button>
        </form>
      </div>
    </>
  );
}

const MD_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

function MessageContent({ content }: { content: string }) {
  // Split content into text and markdown images
  const parts: { type: "text" | "image"; text?: string; alt?: string; url?: string }[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(MD_IMAGE_REGEX)) {
    const before = content.slice(lastIndex, match.index);
    if (before) parts.push({ type: "text", text: before });
    parts.push({ type: "image", alt: match[1], url: match[2] });
    lastIndex = match.index! + match[0].length;
  }

  const remaining = content.slice(lastIndex);
  if (remaining) parts.push({ type: "text", text: remaining });

  // If no images found, just render as text
  if (!parts.some((p) => p.type === "image")) {
    return <div>{content}</div>;
  }

  return (
    <div>
      {parts.map((part, i) =>
        part.type === "text" ? (
          <span key={i}>{part.text}</span>
        ) : (
          <div key={i} className="search-result-image">
            <img
              src={part.url}
              alt={part.alt || "search result"}
              loading="lazy"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )
      )}
    </div>
  );
}

function toolLabel(tool: string, args?: Record<string, unknown>): string {
  if (tool === "search_for_images" && args?.query) {
    return `\nSearching for "${args.query}"...\n`;
  }
  if (tool === "download_and_save_image") {
    return `\nDownloading image...\n`;
  }
  if (tool === "add_text") {
    return `\nAdding text overlay...\n`;
  }
  if (tool === "make_slack_ready") {
    return `\nOptimizing for Slack...\n`;
  }
  return `\nRunning ${tool}...\n`;
}

function EmojiPreviews({ content }: { content: string }) {
  const imageIds = extractImageIds(content);
  const downloadIds = imageIds.filter((id) => {
    const idx = content.indexOf(id);
    const surrounding = content.slice(Math.max(0, idx - 80), idx + 80);
    return (
      surrounding.includes("download") ||
      surrounding.includes("image_id") ||
      surrounding.includes("Slack-ready") ||
      surrounding.includes("slack-ready") ||
      surrounding.includes("/api/")
    );
  });

  if (downloadIds.length === 0) return null;

  return (
    <div className="emoji-preview">
      {downloadIds.map((id) => (
        <div key={id} className="emoji-card">
          <img
            src={getImageUrl(id)}
            alt={`emoji ${id}`}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
          <a
            className="download-btn"
            href={getDownloadUrl(id)}
            download
            onClick={() => trackEvent("emoji_downloaded", { image_id: id })}
          >
            Download
          </a>
        </div>
      ))}
    </div>
  );
}

export default App;
