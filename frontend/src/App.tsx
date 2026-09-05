import { useState, useRef, useEffect, useCallback } from "react";
import { streamChat, editImage, apiUrl, type EmojiReady, type SearchResult } from "./api";
import { EmojiCard, EmojiEditor } from "./EmojiEditor";
import { trackEvent } from "./posthog";
import "./App.css";

interface Message {
  role: "user" | "assistant";
  content: string;
  emojis: EmojiReady[];
  results?: SearchResult[];
  interrupted?: boolean;
  hiddenResults?: string[];
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

const STORAGE_KEY = "emoji-hero-conversation-v1";
function restore(): {sessionId: string; messages: Message[]} {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (value && typeof value.sessionId === "string" && Array.isArray(value.messages)) {
      return {...value, messages: value.messages.filter((m: Message) =>
        ["user", "assistant"].includes(m.role) && typeof m.content === "string" && Array.isArray(m.emojis))};
    }
  } catch { /* Storage may be unavailable. */ }
  return {sessionId: crypto.randomUUID(), messages: []};
}

function App() {
  const [initial] = useState(restore);
  const [messages, setMessages] = useState<Message[]>(initial.messages);
  const [sessionId, setSessionId] = useState(initial.sessionId);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const [editor, setEditor] = useState<{emoji: EmojiReady; mode: "crop" | "text"} | null>(null);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const stickToBottom = useRef(true);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({sessionId, messages})); } catch { /* Keep working without persistence. */ }
  }, [sessionId, messages]);
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
    if (stickToBottom.current) messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || busy.current) return;
    busy.current = true;
    stickToBottom.current = true;
    setInput(""); setIsStreaming(true); setStatus("Working…");
    setMessages((prev) => [...prev, {role: "user", content: text, emojis: []},
      {role: "assistant", content: "", emojis: [], interrupted: true}]);
    const abort = new AbortController(); controller.current = abort;
    trackEvent("chat_message_sent", {message_length: text.length});
    const history = messages.slice(-30).map((m) => ({role: m.role, content: m.content +
      (m.results?.length ? "\nImages: " + JSON.stringify(m.results) : "") +
      (m.emojis.length ? "\nEdited images: " + JSON.stringify(m.emojis) : "")}));
    try {
      let completed = false;
      await streamChat(text, sessionId, (chunk) => {
        if (chunk.type === "tool_call") { setStatus(toolLabel(chunk.tool || "")); return; }
        if (chunk.type === "done") { completed = true; return; }
        if (chunk.type === "error") completed = true;
        setMessages((prev) => {
          const last = {...prev[prev.length - 1]};
          if (chunk.type === "text_delta") last.content += chunk.content || "";
          if (chunk.type === "search_results") last.results = chunk.results || [];
          if (chunk.type === "error") last.content = chunk.content || "Could not complete the request. Please try again.";
          if (chunk.type === "emoji_ready" && chunk.image_id && chunk.image_url && chunk.download_url && !last.emojis.some(e => e.image_id === chunk.image_id)) {
            last.emojis = [...last.emojis, {image_id:chunk.image_id, image_url:chunk.image_url, download_url:chunk.download_url, source_id:chunk.source_id, text_source_id:chunk.text_source_id, text:chunk.text, position:chunk.position, font_size:chunk.font_size}];
          }
          return [...prev.slice(0, -1), last];
        });
      }, history, abort.signal);
      if (!completed) throw new Error("Response interrupted. Please try again.");
      setMessages(prev => prev.map((m, i) => i === prev.length-1 ? {...m, interrupted:false} : m));
    } catch (error) {
      setMessages(prev => prev.map((m, i) => i === prev.length-1 ? {...m, interrupted:false,
        content: m.content + (m.content ? "\n\n" : "") + (abort.signal.aborted ? "Stopped." : (error as Error).message)} : m));
    } finally { busy.current = false; setIsStreaming(false); setStatus(""); controller.current = null; }
  };

  async function selectImage(result: SearchResult) {
    if (busy.current) return;
    busy.current = true; setIsStreaming(true); setStatus("Preparing image…");
    try {
      const emoji = await editImage({image_id: result.image_id});
      setMessages(prev => [...prev, {role:"user", content:"Selected an image.", emojis:[]},
        {role:"assistant", content:"", emojis:[emoji]}]);
      stickToBottom.current = true;
    } catch (error) { setMessages(prev => [...prev, {role:"assistant", content:(error as Error).message, emojis:[]}]); }
    finally { busy.current = false; setIsStreaming(false); setStatus(""); }
  }

  function newEmoji() {
    if (busy.current) return;
    setMessages([]); setSessionId(crypto.randomUUID()); setInput("");
    inputRef.current?.focus();
  }

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
            {messages.length > 0 && <button className="theme-toggle" disabled={isStreaming} onClick={newEmoji}>New emoji</button>}
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
        <div className="messages" role="log" aria-label="Emoji conversation" onScroll={(e) => {
          const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}>
          {messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role}`}>
              <span className="message-author">{msg.role === "user" ? "You" : "Emoji Hero"}</span>
              {msg.content && <div>{msg.content.replace(/\/?api\/download\/[a-f0-9]{12}/g, "")}</div>}
              {msg.results && <SearchGallery results={msg.results} hidden={msg.hiddenResults || []} onHide={(id) => setMessages(prev => prev.map((m, index) => index === i ? {...m, hiddenResults: [...new Set([...(m.hiddenResults || []), id])]} : m))} disabled={isStreaming} onSelect={selectImage} />}
              {msg.emojis.map(emoji => <EmojiCard key={emoji.image_id} emoji={emoji} disabled={isStreaming} onEdit={mode => setEditor({emoji, mode})} />)}
              {msg.interrupted && !isStreaming && <p className="muted">Response interrupted. Send your request again to continue.</p>}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      <div className={`input-area${messages.length === 0 ? " input-welcome" : ""}`}>
        {status && <div className="progress" role="status">{status}{controller.current && <button onClick={() => controller.current?.abort()}>Stop</button>}</div>}
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What are you looking for?"
            aria-label="Describe the emoji you want"
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
      {editor && <EmojiEditor emoji={editor.emoji} mode={editor.mode} onClose={() => setEditor(null)} onSave={(emoji) => {
        setMessages(prev => [...prev, {role:"assistant", content: editor.mode === "crop" ? "Crop updated." : "Text updated.", emojis:[emoji]}]);
        stickToBottom.current = true;
      }} />}
    </>
  );
}

function toolLabel(tool: string): string {
  if (tool === "search_for_images") return "Searching…";
  if (tool === "download_and_save_image") return "Loading image…";
  if (tool === "make_slack_ready") return "Preparing download…";
  return "Editing…";
}

function SearchGallery({results, hidden, onHide, disabled, onSelect}: {results: SearchResult[]; hidden: string[]; onHide: (id: string) => void; disabled: boolean; onSelect: (result: SearchResult) => void}) {
  const available = results.filter(r => !hidden.includes(r.image_id));
  return <div className="search-gallery-wrap">
    {available.length ? <div className="search-gallery">{available.map((result, index) => <div className="search-tile" key={result.image_id}>
      <button disabled={disabled} className="select-image" onClick={() => onSelect(result)} aria-label={`Select image ${index + 1}: ${result.description}`}>
        <img src={apiUrl(result.image_url)} alt={result.description} onError={() => onHide(result.image_id)} />
        <span>Use image</span>
      </button>
      <button className="hide-result" onClick={() => onHide(result.image_id)}>Hide result</button>
    </div>)}</div> : <p>No usable images. Try a different search.</p>}
    {hidden.length > 0 && <p className="muted">{hidden.length} unavailable or hidden {hidden.length === 1 ? "result" : "results"}.</p>}
  </div>;
}

export default App;
