/** Normalize account links without treating different posts or query IDs as one account. */
export function profileIdentity(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (!["https:", "http:"].includes(url.protocol)) return undefined;
    let host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (["m.instagram.com", "mobile.instagram.com"].includes(host)) host = "instagram.com";
    if (["twitter.com", "mobile.twitter.com", "www.x.com"].includes(host)) host = "x.com";
    if (["myfreecams.com", "mfc.im"].includes(host)) {
      const username = decodeURIComponent(url.hash.slice(1) || url.pathname.split("/").filter(Boolean)[0] || "");
      if (/^[a-z0-9_]+$/i.test(username)) return `myfreecams.com/${username.toLowerCase()}`;
    }
    let pathname = url.pathname.replace(/\/+$/, "") || "/";
    const usernameHosts = ["instagram.com", "x.com", "onlyfans.com", "twitch.tv", "chaturbate.com", "stripchat.com", "cam4.com"];
    if (usernameHosts.includes(host) && /^\/[a-z0-9_.@-]+$/i.test(pathname)) {
      pathname = pathname.toLowerCase();
      // Query IDs on root/page URLs can identify different accounts.
      if (!["/profile.php", "/watch", "/p", "/reel", "/stories", "/accounts"].includes(pathname)) url.search = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ["igsh", "igshid", "fbclid", "gclid"].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `${host}${url.port ? `:${url.port}` : ""}${pathname}${url.search}`;
  } catch { return undefined; }
}

export type PerformerConflict = {
  performerId: string;
  existingPerformer: { id: string; name: string };
  profileUrl?: string;
};
