import { useState, useRef, useEffect, useCallback } from "react";
import { flushSync } from "react-dom";
import { streamChat, type ChatChunk, type EmojiReady } from "./api";
import { getDistinctId, trackEvent } from "./posthog";
import "./App.css";

interface Message {
  role: "user" | "assistant";
  content: string;
  emojis: EmojiReady[];
}

const SUGGESTIONS = [
  { title: "This is fine", prompt: "Find me a 'this is fine' meme" },
  { title: "Party parrot", prompt: "I need a thumbs up parrot emoji" },
  { title: "LGTM", prompt: "Get me a 'LGTM' reaction image" },
  { title: "Mind blown", prompt: "Find a 'mind blown' reaction image for Slack" },
];

const THEMES = [
  { id: "dark", name: "Dark", color: "#f59e0b" },
  { id: "light", name: "Light", color: "#7660c8" },
  { id: "midnight", name: "Midnight", color: "#06b6d4" },
  { id: "sunset", name: "Sunset", color: "#f97316" },
  { id: "forest", name: "Forest", color: "#10b981" },
] as const;

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId] = useState(() => getDistinctId() || crypto.randomUUID());
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "light");
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

    const userMessage: Message = { role: "user", content: text, emojis: [] };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsStreaming(true);
    trackEvent("chat_message_sent", {
      message_length: text.trim().length,
      conversation_turn: messages.filter((m) => m.role === "user").length + 1,
    });

    // Add empty assistant message for streaming
    setMessages((prev) => [...prev, { role: "assistant", content: "", emojis: [] }]);

    try {
      await streamChat(text, sessionId, (chunk: ChatChunk) => {
        // Track outside the state updater — updaters can re-run under StrictMode
        if (chunk.type === "emoji_ready" && chunk.image_id) {
          trackEvent("emoji_ready", { image_id: chunk.image_id });
        } else if (chunk.type === "error") {
          trackEvent("chat_error_shown", { source: "stream" });
        }
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
            } else if (chunk.type === "error") {
              const message = chunk.content || "Something went wrong. Please try again.";
              return [...updated, { ...last, content: last.content ? `${last.content}\n\n${message}` : message }];
            } else if (chunk.type === "emoji_ready" && chunk.image_id && chunk.image_url && chunk.download_url) {
              if (last.emojis.some((e) => e.image_id === chunk.image_id)) return prev;
              const emoji: EmojiReady = {
                image_id: chunk.image_id,
                image_url: chunk.image_url,
                download_url: chunk.download_url,
              };
              return [...updated, { ...last, emojis: [...last.emojis, emoji] }];
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
      trackEvent("chat_error_shown", { source: "request" });
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
        <div className="header-inner">
          <div className="header-brand">
            <h1 className="header-title">emoji hero<span>.</span></h1>
          </div>
          <div className="header-actions">
            <div className="theme-picker" ref={themeRef}>
              <button
                className="theme-toggle"
                onClick={() => setThemeOpen(!themeOpen)}
                aria-label="Change theme"
                aria-expanded={themeOpen}
                onKeyDown={(event) => { if (event.key === "Escape") setThemeOpen(false); }}
              >
                Appearance
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
      </header>

      {messages.length === 0 ? (
        <div className="welcome">
          <h2>Find an emoji</h2>
          <p>Search and edit images for use as Slack emoji.</p>
        </div>
      ) : (
        <div className="messages" role="log" aria-label="Emoji conversation" aria-live="polite">
          {messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role}`}>
              <span className="message-author">{msg.role === "user" ? "You" : "Emoji Hero"}</span>
              {msg.content ? <MessageContent content={msg.content} /> : <span className="thinking">Working…</span>}
              {msg.role === "assistant" && msg.emojis.length > 0 && (
                <EmojiPreviews emojis={msg.emojis} />
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      <div className={`input-area${messages.length === 0 ? " input-welcome" : ""}`}>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What are you looking for?"
            aria-label="Describe the emoji you want"
            disabled={isStreaming}
            autoFocus
          />
          <button type="submit" aria-label={isStreaming ? "Generating emoji" : "Send message"} disabled={isStreaming || !input.trim()}>
            {isStreaming ? "…" : <span aria-hidden="true">↑</span>}
          </button>
        </form>
        {messages.length === 0 && (
          <div className="suggestions" aria-label="Suggested prompts">
            <span>Examples</span>
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion.title} onClick={() => sendMessage(suggestion.prompt)}>
                {suggestion.title}
              </button>
            ))}
          </div>
        )}
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

function EmojiPreviews({ emojis }: { emojis: EmojiReady[] }) {
  return (
    <div className="emoji-preview">
      {emojis.map((emoji) => (
        <div key={emoji.image_id} className="emoji-card">
          <img
            src={emoji.image_url}
            alt={`emoji ${emoji.image_id}`}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
          <a
            className="download-btn"
            href={emoji.download_url}
            download
            onClick={() => trackEvent("emoji_downloaded", { image_id: emoji.image_id })}
          >
            Download
          </a>
        </div>
      ))}
    </div>
  );
}

export default App;
