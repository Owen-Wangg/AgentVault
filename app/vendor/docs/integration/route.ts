import { NIMBUS_DOCS_HTML, STATIC_PAGE_HEADERS } from "@/server/vendor/pages";

// The poisoned demo vendor docs page (taint-and-intent task 6). A route
// handler instead of a page, because the injection sits in an HTML
// comment, which React can't render.
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(NIMBUS_DOCS_HTML, { status: 200, headers: STATIC_PAGE_HEADERS });
}
