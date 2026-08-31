import { Activity, BarChart3, Heart, History, House, Library, Logs, Plug, Radio, Settings, Users } from "lucide-react";

const groups = [
  { label: "OPEN EASYX", items: [
    { href: "/media", label: "Home", icon: House },
    { href: "/library", label: "Library", icon: Library },
    { href: "/live-cam", label: "Live Cam", icon: Radio },
    { href: "/favorites", label: "Favorites", icon: Heart },
    { href: "/history", label: "History", icon: History },
    { href: "/statistics", label: "Statistics", icon: BarChart3 },
  ] },
  { label: "COLLECT", items: [
    { href: "/performers", label: "Performers", icon: Users },
    { href: "/activity", label: "Activity", icon: Activity },
  ] },
  { label: "SYSTEM", items: [
    { href: "/plugins", label: "Plugins", icon: Plug },
    { href: "/logs", label: "Logs", icon: Logs },
    { href: "/settings", label: "Settings", icon: Settings },
  ] },
] as const;

function activeRoute(pathname: string, href: string) {
  if (href === "/media") return pathname === "/" || pathname === "/overview" || pathname === "/media";
  if (href === "/library") return pathname.startsWith("/library") || pathname.startsWith("/watch/") || pathname.startsWith("/photos/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function UnifiedNavigation({ pathname = window.location.pathname }: { pathname?: string } = {}) {
  return <nav className="unified-nav" aria-label="Open EasyX navigation">{groups.map((group) => <section className="nav-group" key={group.label}><p>{group.label}</p>{group.items.map(({ href, label, icon: Icon }) => <a key={href} href={href} className={activeRoute(pathname, href) ? "active" : ""}><Icon size={18}/><span>{label}</span></a>)}</section>)}</nav>;
}
