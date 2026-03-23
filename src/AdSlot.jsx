import { useEffect, useRef, useState } from "react";
import { isDesktop, PURCHASE_URL } from "./edition";

const CLIENT_ID = "ca-pub-4678796507563996";

function AdUnit({ style, format = "auto", slot = "" }) {
  const adRef = useRef(null);
  const pushed = useRef(false);

  useEffect(() => {
    if (pushed.current) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      pushed.current = true;
    } catch {}
  }, []);

  return (
    <ins
      ref={adRef}
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
  const isCompact = variant === "sidebar";
  return (
    <a
      href={PURCHASE_URL}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        background: "linear-gradient(135deg, #13121c 0%, #19182a 100%)",
        border: "1px solid #1f1e30",
        borderRadius: 6,
        padding: isCompact ? "12px 8px" : "8px 16px",
        textDecoration: "none",
        gap: isCompact ? 6 : 4,
        boxSizing: "border-box",
      }}
    >
      <span style={{ fontSize: isCompact ? 18 : 14 }}>🦉</span>
      <span style={{ fontSize: isCompact ? 11 : 10, color: "#a5b4fc", fontWeight: 700, textAlign: "center", lineHeight: 1.4 }}>
        {isCompact ? "Go ad-free" : "Remove ads"}
      </span>
      <span style={{ fontSize: isCompact ? 10 : 9, color: "#3d3b60", textAlign: "center", lineHeight: 1.3 }}>
        GangOwl Desktop — $11.99
      </span>
    </a>
  );
}

export default function AdSlot({ variant = "sidebar", style = {} }) {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    // Detect adblocker after a short delay
    const timer = setTimeout(() => {
      const testAd = document.querySelector(".adsbygoogle");
      if (!testAd || testAd.offsetHeight === 0 || !window.adsbygoogle) {
        setBlocked(true);
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Never show ads in desktop edition
  if (isDesktop) return null;

  return (
    <div style={{ position: "relative", overflow: "hidden", ...style }}>
      {blocked ? (
        <Fallback variant={variant} />
      ) : (
        <>
          {/* Fallback behind the ad — shows if ad fails to load */}
          <div style={{ position: "absolute", inset: 0, zIndex: 0 }}>
            <Fallback variant={variant} />
          </div>
          <div style={{ position: "relative", zIndex: 1 }}>
            <AdUnit
              style={variant === "banner" ? { height: 50 } : { minHeight: 200 }}
              format={variant === "banner" ? "horizontal" : "rectangle"}
            />
          </div>
        </>
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
        <AdUnit style={{ minHeight: 250 }} format="rectangle" />
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
