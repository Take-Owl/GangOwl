import { useEffect, useRef, useState } from "react";
import { isDesktop, PURCHASE_URL } from "./edition";

const CLIENT_ID = "ca-pub-4678796507563996";

function AdUnit({ style, format = "auto", slot = "" }) {
  const pushed = useRef(false);
  useEffect(() => {
    if (pushed.current) return;
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); pushed.current = true; } catch {}
  }, []);
  return (
    <ins className="adsbygoogle" style={{ display: "block", ...style }}
      data-ad-client={CLIENT_ID} data-ad-slot={slot} data-ad-format={format} data-full-width-responsive="true" />
  );
}

function Fallback({ variant }) {
  const isBanner = variant === "banner";
  const onClick = () => { window.open(PURCHASE_URL, "_blank"); };
  return (
    <div onClick={onClick} style={{
      display: "flex", flexDirection: isBanner ? "row" : "column",
      alignItems: "center", justifyContent: "center", cursor: "pointer",
      width: "100%", height: "100%",
      background: "linear-gradient(135deg, #13121c 0%, #19182a 100%)",
      border: isBanner ? "none" : "1px solid #1f1e30", borderRadius: isBanner ? 0 : 6,
      padding: isBanner ? "0 16px" : "16px 8px",
      gap: isBanner ? 8 : 6, boxSizing: "border-box",
    }}>
      <span style={{ fontSize: isBanner ? 12 : 20 }}>🦉</span>
      <span style={{ fontSize: isBanner ? 9 : 11, color: "#a5b4fc", fontWeight: 700, lineHeight: 1.4 }}>
        {isBanner ? "Remove ads —" : "Go ad-free"}
      </span>
      <span style={{ fontSize: isBanner ? 9 : 10, color: "#3d3b60", lineHeight: 1.3 }}>
        GangOwl Desktop $11.99
      </span>
    </div>
  );
}

export default function AdSlot({ variant = "sidebar", style = {} }) {
  const [showFallback, setShowFallback] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    // After 3s, check if ad loaded (has iframe child or nonzero height ins)
    const timer = setTimeout(() => {
      const el = containerRef.current;
      if (!el) return;
      const ins = el.querySelector(".adsbygoogle");
      const hasAd = ins && (ins.querySelector("iframe") || ins.offsetHeight > 10);
      if (!hasAd) setShowFallback(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  if (isDesktop) return null;

  const isBanner = variant === "banner";
  const h = isBanner ? 32 : 200;

  return (
    <div ref={containerRef} style={{ height: h, maxHeight: h, overflow: "hidden", flexShrink: 0, ...style }}>
      {showFallback ? (
        <Fallback variant={variant} />
      ) : (
        <AdUnit style={{ height: h }} format={isBanner ? "horizontal" : "rectangle"} />
      )}
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
        padding: "24px", maxWidth: 400, width: "90%", textAlign: "center",
      }}>
        <div style={{ fontSize: 12, color: "#3d3b60", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Exporting your sheet…
        </div>
        <div style={{ minHeight: 250 }}>
          <Fallback variant="sidebar" />
        </div>
        <div style={{ marginTop: 16, fontSize: 11, color: "#3d3b60" }}>
          {countdown > 0 ? `Continuing in ${countdown}s…` : "Done!"}
        </div>
      </div>
    </div>
  );
}
