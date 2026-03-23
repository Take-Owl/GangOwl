import { useState, useEffect } from "react";
import { isDesktop, getSavedLicense, saveLicense, verifyLicense, PURCHASE_URL } from "./edition";

export default function LicenseGate({ children }) {
  const [licensed, setLicensed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    // Web version: always licensed (ad-supported)
    if (!isDesktop) { setLicensed(true); setChecking(false); return; }
    // Desktop: check saved license
    const saved = getSavedLicense();
    if (saved?.valid) { setLicensed(true); }
    setChecking(false);
  }, []);

  const handleVerify = async () => {
    if (!input.trim()) { setError("Enter your email or license key."); return; }
    setVerifying(true); setError("");
    try {
      const result = await verifyLicense(input.trim());
      saveLicense({ valid: true, email: result.email, verifiedAt: new Date().toISOString() });
      setLicensed(true);
    } catch (e) {
      setError(e.message || "Verification failed.");
    }
    setVerifying(false);
  };

  if (checking) return null;
  if (licensed) return children;

  // License activation screen
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      height: "100dvh", background: "#0c0b12", color: "#e2e0ff",
      fontFamily: "'DM Mono','Courier New',monospace",
    }}>
      <div style={{
        background: "#13121c", border: "1px solid #1f1e30", borderRadius: 12,
        padding: "40px 36px", maxWidth: 400, width: "90%", textAlign: "center",
      }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🦉</div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#a5b4fc", margin: "0 0 4px" }}>
          Gang<span style={{ color: "#f59e0b" }}>Owl</span>
        </h1>
        <p style={{ fontSize: 12, color: "#3d3b60", marginBottom: 24 }}>Desktop Edition</p>

        <p style={{ fontSize: 13, color: "#e2e0ff", lineHeight: 1.6, marginBottom: 20 }}>
          Enter the email you used to purchase, or your license key.
        </p>

        <input
          type="text"
          placeholder="Email or license key"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleVerify()}
          style={{
            width: "100%", padding: "10px 12px", fontSize: 13,
            background: "#0c0b12", border: "1px solid #1f1e30", borderRadius: 6,
            color: "#e2e0ff", outline: "none", marginBottom: 12,
            boxSizing: "border-box",
          }}
        />

        {error && (
          <div style={{
            fontSize: 11, color: "#ef4444", marginBottom: 12,
            padding: "8px", background: "#1a0a0a", borderRadius: 4,
          }}>
            {error}
          </div>
        )}

        <button
          onClick={handleVerify}
          disabled={verifying}
          style={{
            width: "100%", padding: "12px", fontSize: 13, fontWeight: 700,
            background: "#6366f1", color: "#fff", border: "none", borderRadius: 6,
            cursor: verifying ? "wait" : "pointer", marginBottom: 16,
            letterSpacing: "0.05em", textTransform: "uppercase",
          }}
        >
          {verifying ? "Verifying…" : "Activate"}
        </button>

        <div style={{ fontSize: 11, color: "#3d3b60" }}>
          Don't have a license?{" "}
          <a
            href={PURCHASE_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#a5b4fc", textDecoration: "none" }}
          >
            Purchase for $11.99
          </a>
        </div>
      </div>
    </div>
  );
}
