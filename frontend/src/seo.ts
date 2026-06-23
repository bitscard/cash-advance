// Per-route SEO for the SPA.
//
// Vercel rewrites every path to the same index.html, so without this every
// route would share the root <title>/description and crawlers couldn't tell
// /terms from the landing page. applyRouteSeo() rewrites the document head on
// each navigation: marketing routes get unique, indexable metadata; the app,
// auth, OAuth, and internal routes are marked noindex so they stay out of
// search results without ever being named in the public robots.txt.

const SITE_URL = "https://advance.getbits.app";
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png`;

type RouteSeo = {
  title: string;
  description: string;
  index: boolean;
};

// Keyed by pathname. The admin path is intentionally not referenced here by
// its literal value — anything not in this map falls through to NOINDEX.
const ROUTES: Record<string, RouteSeo> = {
  "/": {
    title: "Advance by Bits — Get your wages before payday",
    description:
      "Advance by Bits gives you instant access to your earned wages before payday — up to $300, no credit check, no interest, no late fees, no collections.",
    index: true,
  },
  "/story": {
    title: "Our story — Advance by Bits",
    description:
      "Why we built Advance by Bits: fee-free early access to the wages you've already earned, without the traps of payday lending.",
    index: true,
  },
  "/terms": {
    title: "Terms & Conditions — Advance by Bits",
    description: "The terms and conditions for using Advance by Bits.",
    index: true,
  },
  "/privacy": {
    title: "Privacy Policy — Advance by Bits",
    description:
      "How Advance by Bits collects, uses, and protects your personal and financial information.",
    index: true,
  },
};

const NOINDEX: RouteSeo = {
  title: "Advance by Bits",
  description:
    "Instant access to your earned wages. No credit check, no interest, no collections.",
  index: false,
};

function setMeta(selector: string, attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setCanonical(href: string) {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

export function applyRouteSeo(pathname: string) {
  const seo = ROUTES[pathname] ?? NOINDEX;
  const canonical = `${SITE_URL}${pathname === "/" ? "/" : pathname}`;

  document.title = seo.title;
  setMeta('meta[name="description"]', "name", "description", seo.description);
  setMeta(
    'meta[name="robots"]',
    "name",
    "robots",
    seo.index ? "index, follow, max-image-preview:large" : "noindex, nofollow",
  );

  setMeta('meta[property="og:title"]', "property", "og:title", seo.title);
  setMeta('meta[property="og:description"]', "property", "og:description", seo.description);
  setMeta('meta[property="og:url"]', "property", "og:url", seo.index ? canonical : SITE_URL);
  setMeta('meta[property="og:image"]', "property", "og:image", DEFAULT_OG_IMAGE);
  setMeta('meta[name="twitter:title"]', "name", "twitter:title", seo.title);
  setMeta('meta[name="twitter:description"]', "name", "twitter:description", seo.description);

  // Only indexable pages advertise a canonical; app/auth routes shouldn't.
  setCanonical(seo.index ? canonical : SITE_URL);
}
