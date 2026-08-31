export const pageRoutes = {
  dashboard: "/overview",
  library: "/performers",
  activity: "/activity",
  logs: "/logs",
  plugins: "/plugins",
  settings: "/settings",
} as const;

export type PageKey = keyof typeof pageRoutes;

export function canonicalEntryPath(pathname: string): string {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalized === "/discover") return "/performers";
  return normalized === "/" || normalized === "/overview" ? "/media" : pathname;
}

export function pagePath(page: PageKey): string {
  return pageRoutes[page];
}

export function pageFromPath(pathname: string): PageKey {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const match = (Object.entries(pageRoutes) as Array<[PageKey, string]>).find(([, route]) => route === normalized);
  return match?.[0] ?? "dashboard";
}
