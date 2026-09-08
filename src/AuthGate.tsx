import React, { useEffect, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { api } from "./api.js";
import { Login } from "./Login.js";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    const onUnauthorized = () => setStatus("unauthenticated");
    window.addEventListener("easyx:unauthorized", onUnauthorized);
    api<{ authenticated: boolean }>("/api/auth/me")
      .then((result) => setStatus(result.authenticated ? "authenticated" : "unauthenticated"))
      .catch(() => setStatus("unauthenticated"));
    return () => window.removeEventListener("easyx:unauthorized", onUnauthorized);
  }, []);

  if (status === "loading") {
    return <div className="boot"><div className="logo-mark">EX</div><LoaderCircle className="spin" /><span>Starting Open EasyX…</span></div>;
  }
  if (status === "unauthenticated") {
    return <Login onAuthenticated={() => setStatus("authenticated")} />;
  }
  return <>{children}</>;
}
