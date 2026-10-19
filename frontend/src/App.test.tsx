import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { streamChat, type ChatChunk } from "./api";

vi.mock("./api", () => ({
  streamChat: vi.fn(),
  editImage: vi.fn(),
  apiUrl: (path: string) => path,
}));

vi.mock("./posthog", () => ({
  trackEvent: vi.fn(),
  getDistinctId: () => "test-user",
  getSessionId: () => "test-session",
}));

import App from "./App";

const mockStreamChat = vi.mocked(streamChat);

const ERROR_TEXT = "Something went wrong while generating a response. Please try again.";

function send(text: string) {
  fireEvent.change(screen.getByLabelText("Describe the emoji you want"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

describe("chat SSE stream", () => {
  beforeEach(() => {
    mockStreamChat.mockReset();
  });

  it("shows a single error message when the stream sends an error chunk", async () => {
    mockStreamChat.mockImplementation(async (_m, _s, onChunk: (c: ChatChunk) => void) => {
      // Deliver the chunk after a tick, matching how the real stream reader fires
      // callbacks outside React's synchronous update scope.
      await Promise.resolve();
      onChunk({ type: "error", content: ERROR_TEXT });
    });

    render(<App />);
    send("party parrot");

    await screen.findByText(ERROR_TEXT);
    expect(screen.getAllByText(ERROR_TEXT)).toHaveLength(1);
    // The frontend must not append its own "Response interrupted" text on top of the
    // error the backend already reported.
    expect(screen.queryByText(/Response interrupted\. Please try again\./)).toBeNull();
  });

  it("appends the interruption notice only when the stream ends without a done chunk", async () => {
    mockStreamChat.mockImplementation(async () => {
      // Stream resolves with no "done" and no "error" chunk.
    });

    render(<App />);
    send("party parrot");

    await waitFor(() => expect(screen.getByText(/Response interrupted\. Please try again\./)).toBeInTheDocument());
  });
});
