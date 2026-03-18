import { getDistinctId, getSessionId } from "./posthog";

const API_BASE = import.meta.env.VITE_API_URL || "";

export interface ChatChunk {
  type: "text_delta" | "done" | "tool_call" | "tool_result";
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export async function streamChat(
  message: string,
  sessionId: string,
  onChunk: (chunk: ChatChunk) => void
): Promise<void> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-POSTHOG-SESSION-ID": getSessionId(),
      "X-POSTHOG-DISTINCT-ID": getDistinctId(),
    },
    body: JSON.stringify({ message, session_id: sessionId }),
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
        try {
          onChunk(JSON.parse(trimmed.slice(6)) as ChatChunk);
        } catch {
          // skip malformed
        }
      }
    }
  }

  if (buffer.trim().startsWith("data: ")) {
    try {
      onChunk(JSON.parse(buffer.trim().slice(6)) as ChatChunk);
    } catch {
      // skip
    }
  }
}

export function getImageUrl(imageId: string): string {
  return `${API_BASE}/api/images/${imageId}`;
}

export function getDownloadUrl(imageId: string): string {
  return `${API_BASE}/api/download/${imageId}`;
}
