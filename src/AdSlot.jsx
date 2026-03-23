import { useEffect, useRef, useState } from "react";
import { isDesktop, PURCHASE_URL } from "./edition";

const CLIENT_ID = "ca-pub-4678796507563996";

function Fallback({ variant }) {
  const isBanner = variant === "banner";
  return (
    <div
      onClick={() => window.open(PURCHASE_URL, "_blank")}
      style={{
        display: "flex", flexDirection: "row",
        alignItems: "center", justifyContent: "center", cursor: "pointer",
        width: "100%", height: "100%",
        background: isBanner ? "linear-gradient(90deg, #13121c, #19182a)" : "linear-gradient(135deg, #13121c 0%, #19182a 100%)",
        border: isBanner ? "none" : "1px solid #1f1e30",
        borderRadius: isBanner ? 0 : 6,
        padding: isBanner ? "0 12px" : "12px",
        gap: 8, boxSizing: "border-box", userSelect: "none",
      }}
    >
      <span style={{ fontSize: isBanner ? 11 : 18 }}>🦉</span>
      <span style={{ fontSize: isBanner ? 9 : 11, color: "#a5b4fc", fontWeight: 700, whiteSpace: "nowrap" }}>
        Go ad-free
      </span>
      <span style={{ fontSize: isBanner ? 9 : 10, color: "#6366f1", whiteSpace: "nowrap" }}>
        GangOwl Desktop — $11.99
      </span>
    </div>
  );
}

export default function AdSlot({ variant = "sidebar" }) {
  if (isDesktop) return null;

  const isBanner = variant === "banner";
  const h = isBanner ? 28 : 180;

  return (
    <div style={{
      height: h, minHeight: h, maxHeight: h,
      overflow: "hidden", flexShrink: 0,
      ...(isBanner ? { width: "100%", borderBottom: "1px solid #1f1e30" } : { margin: 8 }),
    }}>
      <Fallback variant={variant} />
    </div>
  );
}

export function ExportAd({ onClose }) {
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    if (isDesktop) { onClose(); return; }
    const timer = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(timer); onClose(); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [onClose]);

  if (isDesktop) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1100, flexDirection: "column",
    }}>
      <div style={{
        background: "#13121c", border: "1px solid #1f1e30", borderRadius: 10,
        padding: "24px", maxWidth: 360, width: "90%", textAlign: "center",
      }}>
        <div style={{ fontSize: 12, color: "#3d3b60", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Exporting your sheet…
        </div>
        <div style={{ height: 180 }}>
          <Fallback variant="sidebar" />
        </div>
        <div style={{ marginTop: 16, fontSize: 11, color: "#3d3b60" }}>
          {countdown > 0 ? `Continuing in ${countdown}s…` : "Done!"}
        </div>
      </div>
    </div>
  );
}
