import { ACME_INVOICE_HTML, STATIC_PAGE_HEADERS } from "@/server/vendor/pages";

// The poisoned supplier invoice for the Payee hijack scenario (payout-rails
// task 7). A route handler instead of a page, because the injection sits in
// an HTML comment, which React can't render.
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(ACME_INVOICE_HTML, { status: 200, headers: STATIC_PAGE_HEADERS });
}
