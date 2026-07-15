// NEXT_PUBLIC_* vars are inlined at build time by Next.js. In prod set these
// to the https:// / wss:// Railway domains; locally they default to the dev
// backends. The JWT is still appended as a `?token=` query param on WS_URL by
// the useSocket hook — only the base URL comes from here.
export const BACKEND_URL = process.env.NEXT_PUBLIC_HTTP_URL ?? "http://localhost:3005"
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080"
