import posthog from "posthog-js";

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY || "";
const POSTHOG_HOST =
  import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";

const USER_ID_KEY = "emoji-hero-user-id";

export function getUserId(): string {
  let userId = localStorage.getItem(USER_ID_KEY);
  if (!userId) {
    userId = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, userId);
  }
  return userId;
}

export function initPostHog() {
  if (!POSTHOG_KEY) {
    console.log("PostHog key not set — analytics disabled");
    return;
  }
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    person_profiles: "identified_only",
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
    capture_exceptions: true,
  });

  // Identify with our stable user ID so frontend and backend events share the same distinct_id
  const userId = getUserId();
  posthog.identify(userId);
}

export function getDistinctId(): string {
  return getUserId();
}

export function getSessionId(): string {
  return posthog.get_session_id?.() || "";
}

// Errors the UI catches and shows never reach exception autocapture, so report
// each one as an exception plus an event the chat funnel can count.
export function reportError(
  surface: string,
  error: unknown,
  properties?: Record<string, unknown>
) {
  const err = error instanceof Error ? error : new Error(String(error));
  const props = { surface, error_message: err.message, ...properties };
  posthog.capture("chat_error_shown", props);
  posthog.captureException(err, props);
}

export function trackEvent(
  event: string,
  properties?: Record<string, unknown>
) {
  posthog.capture(event, properties);
}
