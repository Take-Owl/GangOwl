import { useEffect, useRef, useState } from "react";
import { isDesktop, PURCHASE_URL } from "./edition";

const CLIENT_ID = "ca-pub-4678796507563996";

function AdUnit({ style, format = "auto", slot = "", onLoad }) {
  const containerRef = useRef(null);
  const pushed = useRef(false);

  useEffect(() => {
    if (pushed.current) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      pushed.current = true;
    } catch {}
    // Check if ad actually rendered after delay
    if (onLoad) {
      setTimeout(() => {
        const el = containerRef.current;
        if (el && el.querySelector("iframe")) onLoad(true);
        else onLoad(false);
      }, 3000);
    }
  }, []);

  return (
    <ins
      ref={containerRef}
      className="adsbygoogle"
      style={{ display: "block", ...style }}
      data-ad-client={CLIENT_ID}
      data-ad-slot={slot}
      data-ad-format={format}
      data-full-width-responsive="true"
    />
  );
}

function Fallback({ variant }) {
  const isBanner = variant === "banner";
  return (
    <a
      href={PURCHASE_URL}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        flexDirection: isBanner ? "row" : "column",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        background: "linear-gradient(135deg, #13121c 0%, #19182a 100%)",
        border: "1px solid #1f1e30",
        borderRadius: isBanner ? 0 : 6,
        padding: isBanner ? "4px 16px" : "16px 8px",
        textDecoration: "none",
        gap: isBanner ? 8 : 6,
        boxSizing: "border-box",
      }}
    >
      <span style={{ fontSize: isBanner ? 14 : 20 }}>🦉</span>
      <span style={{ fontSize: isBanner ? 10 : 11, color: "#a5b4fc", fontWeight: 700, textAlign: "center", lineHeight: 1.4 }}>
        {isBanner ? "Remove ads —" : "Go ad-free"}
      </span>
      <span style={{ fontSize: isBanner ? 10 : 10, color: "#3d3b60", textAlign: "center", lineHeight: 1.3 }}>
        GangOwl Desktop — $11.99
      </span>
    </a>
  );
}

export default function AdSlot({ variant = "sidebar", style = {} }) {
  const [adFailed, setAdFailed] = useState(false);

  // Never show ads in desktop edition
  if (isDesktop) return null;

  const isBanner = variant === "banner";
  const height = isBanner ? 50 : 200;

  return (
    <div style={{ position: "relative", overflow: "hidden", height, maxHeight: height, ...style }}>
      {/* Fallback always behind */}
      <div style={{ position: "absolute", inset: 0, zIndex: 0 }}>
        <Fallback variant={variant} />
      </div>
      {/* Ad on top — if it loads, it covers the fallback */}
      {!adFailed && (
        <div style={{ position: "relative", zIndex: 1, height }}>
          <AdUnit
            style={{ height }}
            format={isBanner ? "horizontal" : "rectangle"}
            onLoad={(ok) => { if (!ok) setAdFailed(true); }}
          />
        </div>
      )}
    </div>
  );
}

// Export interstitial — shown briefly during export
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
      zIndex: 1100, flexDirection: "column", gap: 16,
    }}>
      <div style={{
        background: "#13121c", border: "1px solid #1f1e30", borderRadius: 10,
        padding: "24px", maxWidth: 400, width: "90%", textAlign: "center",
      }}>
        <div style={{ fontSize: 12, color: "#3d3b60", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Exporting your sheet…
        </div>
        <div style={{ minHeight: 250, position: "relative" }}>
          <div style={{ position: "absolute", inset: 0, zIndex: 0 }}>
            <Fallback variant="sidebar" />
          </div>
          <div style={{ position: "relative", zIndex: 1 }}>
            <AdUnit style={{ minHeight: 250 }} format="rectangle" />
          </div>
        </div>
        <div style={{ marginTop: 16, fontSize: 11, color: "#3d3b60" }}>
          {countdown > 0 ? `Continuing in ${countdown}s…` : "Done!"}
        </div>
        <a
          href={PURCHASE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 10, color: "#a5b4fc", textDecoration: "none", marginTop: 8, display: "inline-block" }}
        >
          Remove ads — GangOwl Desktop $11.99
        </a>
      </div>
    </div>
  );
}
