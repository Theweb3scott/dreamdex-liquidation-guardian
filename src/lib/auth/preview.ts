/**
 * Preview OAuth placeholders. Server-only. Never import this from client code.
 *
 * The Hideki monitor does not use these values. A deployed host may set
 * GROK_AUTH_CLIENT_ID and GROK_AUTH_CLIENT_SECRET in the environment.
 * This repository ships an empty secret on purpose.
 */
export const PREVIEW_CLIENT_ID = "grok_preview";
export const PREVIEW_CLIENT_SECRET = "";

export const GROK_ISSUER_DEFAULT = "https://auth.grok.me";

/**
 * Host patterns whose callbacks the preview client accepts. Better Auth derives
 * the live preview's real origin from the request host and validates it against
 * this list (wildcard-matched), so the OAuth `redirect_uri` becomes the concrete
 * `https://<preview-host>/api/auth/oauth2/callback/...` the broker allows.
 */
export const PREVIEW_ALLOWED_HOSTS = ["*.grok-sandbox.com"] as const;
