import posthog from "posthog-js";

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY || "";
const POSTHOG_HOST =
  import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";

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
  });
}

export function getDistinctId(): string {
  return posthog.get_distinct_id?.() || "anonymous";
}

export function getSessionId(): string {
  return posthog.get_session_id?.() || "";
}

export function trackEvent(
  event: string,
  properties?: Record<string, unknown>
) {
  posthog.capture(event, properties);
}
