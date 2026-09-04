import { getDistinctId, getSessionId } from "./posthog";

const API_BASE = import.meta.env.VITE_API_URL || "";

export interface EmojiReady {
  image_id: string;
  image_url: string;
  download_url: string;
  source_id?: string;
  text_source_id?: string;
  text?: string;
  position?: string;
  font_size?: number;
}

export interface ChatChunk {
  type: "text_delta" | "done" | "tool_call" | "tool_result" | "emoji_ready" | "search_results" | "error";
  source_id?: string;
  text_source_id?: string;
  text?: string;
  position?: string;
  font_size?: number;
  results?: SearchResult[];
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  image_id?: string;
  image_url?: string;
  download_url?: string;
}

export async function streamChat(
  message: string,
  sessionId: string,
  onChunk: (chunk: ChatChunk) => void,
  history: {role: string; content: string}[] = [],
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-POSTHOG-SESSION-ID": getSessionId(),
      "X-POSTHOG-DISTINCT-ID": getDistinctId(),
    },
    body: JSON.stringify({ message, session_id: sessionId, history }),
  });

  if (!response.ok) {
    throw new Error(`Chat failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        const chunk = JSON.parse(trimmed.slice(6)) as ChatChunk;
        onChunk(chunk);
      }
    }
  }

  if (buffer.trim().startsWith("data: ")) {
    onChunk(JSON.parse(buffer.trim().slice(6)) as ChatChunk);
  }
}

export function getImageUrl(imageId: string): string {
  return `${API_BASE}/api/images/${imageId}`;
}

export function getDownloadUrl(imageId: string): string {
  return `${API_BASE}/api/download/${imageId}`;
}

export interface SearchResult {
  image_id: string;
  image_url: string;
  description: string;
}

export function apiUrl(path: string) { return path.startsWith("/") ? `${API_BASE}${path}` : path; }

export async function editImage(body: {
  image_id: string;
  crop?: {x: number; y: number; width: number; height: number};
  text?: string;
  position?: string;
  font_size?: number;
}): Promise<EmojiReady> {
  const response = await fetch(`${API_BASE}/api/edit`, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(response.status === 404 ? "This image has expired. Search again." : "Could not apply the edit. Please try again.");
  return response.json();
}
