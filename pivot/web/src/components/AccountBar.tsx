import { api } from "../api";
import { useState } from "react";

export function AccountBar({ account, autoEnabled }: { account: any; autoEnabled: boolean }) {
  const [enabled, setEnabled] = useState(autoEnabled);

  const toggle = async () => {
    const r = enabled ? await api.kill(false) : await api.resume();
    setEnabled(r.enabled);
  };

  const cell = (label: string, value: string) => (
    <div style={{ padding: "8px 16px" }}>
      <div style={{ fontSize: 11, color: "#8b949e" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: "#161b22", borderRadius: 8, marginBottom: 16 }}>
      <div style={{ display: "flex" }}>
        {cell("Balance", account ? `€${account.balance?.toFixed(2)}` : "—")}
        {cell("Equity", account ? `€${account.equity?.toFixed(2)}` : "—")}
        {cell("Open", account ? String(account.open_positions ?? 0) : "—")}
      </div>
      <button onClick={toggle} style={{
        margin: 12, padding: "10px 20px", borderRadius: 6, border: "none",
        cursor: "pointer", fontWeight: 700, color: "#fff",
        background: enabled ? "#da3633" : "#238636",
      }}>
        {enabled ? "■ KILL-SWITCH" : "▶ RESUME AUTO"}
      </button>
    </div>
  );
}
