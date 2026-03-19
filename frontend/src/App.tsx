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

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId] = useState(() => getDistinctId() || crypto.randomUUID());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
      <div className="header">
        <span>🦸</span>
        <h1>Emoji Hero</h1>
        <p>Custom Slack emoji, fast</p>
      </div>

      {messages.length === 0 ? (
        <div className="welcome">
          <div className="emoji">🦸</div>
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
