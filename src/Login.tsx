import React, { useState, type FormEvent } from "react";
import { LoaderCircle, Lock, ShieldCheck, X } from "lucide-react";
import { api } from "./api.js";
import "./login.css";

export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      onAuthenticated();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sign in failed");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="logo-mark big">EX</div>
        <p className="eyebrow">OPEN EASYX</p>
        <h1>Welcome back</h1>
        <p className="lede">Sign in to your private media suite.</p>
        {error && <div className="login-error"><X size={15} />{error}</div>}
        <label className="login-field">
          <Lock size={15} />
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Admin password"
            disabled={busy}
            aria-label="Admin password"
          />
        </label>
        <button className="primary wide" type="submit" disabled={busy || !password}>
          <ShieldCheck size={16} />
          {busy ? <LoaderCircle className="spin" /> : "Sign in"}
        </button>
        <small className="fineprint">This instance is protected. All API access requires a valid session.</small>
      </form>
    </div>
  );
}
