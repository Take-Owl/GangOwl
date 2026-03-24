import { useEffect, useRef, useState } from "react";
import { isDesktop, PURCHASE_URL } from "./edition";

const CLIENT_ID = "ca-pub-4678796507563996";

// ── Ad slot IDs from Google AdSense dashboard ──
// Replace these with your actual slot IDs once you create ad units in AdSense.
// To create them: AdSense → Ads → By ad unit → Create:
//   1. "GangOwl Banner" (horizontal banner) → paste slot ID below
//   2. "GangOwl Sidebar" (display ad, rectangle) → paste slot ID below
//   3. "GangOwl Export" (display ad, rectangle) → paste slot ID below
const SLOTS = {
  banner: "",     // e.g. "1234567890"
  sidebar: "",    // e.g. "0987654321"
  export: "",     // e.g. "1122334455"
};

// ── AdSense unit ──
function AdUnit({ slot, style, format = "auto" }) {
  const ref = useRef(null);
  const pushed = useRef(false);

  useEffect(() => {
    if (pushed.current || !slot) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      pushed.current = true;
    } catch {}
  }, [slot]);

  if (!slot) return null;

  return (
    <ins
      ref={ref}
      className="adsbygoogle"
      style={{ display: "block", ...style }}
      data-ad-client={CLIENT_ID}
      data-ad-slot={slot}
      data-ad-format={format}
      data-full-width-responsive="true"
    />
  );
}

// ── Fallback upsell (shown when ads blocked or no slot configured) ──
const NAV_LINKS = [
  { label: "Guide", href: "/guide.html" },
  { label: "DTF Guide", href: "/dtf-printing.html" },
  { label: "Die-Cut Guide", href: "/die-cut-stickers.html" },
  { label: "About", href: "/about.html" },
];

function Fallback({ variant }) {
  const isBanner = variant === "banner";
  return (
    <div
      style={{
        display: "flex", flexDirection: "row",
        alignItems: "center", justifyContent: isBanner ? "space-between" : "center",
        width: "100%", height: "100%",
        background: isBanner ? "linear-gradient(90deg, #13121c, #19182a)" : "linear-gradient(135deg, #13121c 0%, #19182a 100%)",
        border: isBanner ? "none" : "1px solid #1f1e30",
        borderRadius: isBanner ? 0 : 6,
        padding: isBanner ? "0 12px" : "12px",
        gap: 8, boxSizing: "border-box", userSelect: "none",
      }}
    >
      {isBanner && (
        <nav style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {NAV_LINKS.map(l => (
            <a key={l.href} href={l.href} style={{ fontSize: 9, color: "#6366f1", textDecoration: "none", whiteSpace: "nowrap" }}
              onMouseEnter={e => e.target.style.color = "#a5b4fc"} onMouseLeave={e => e.target.style.color = "#6366f1"}>
              {l.label}
            </a>
          ))}
        </nav>
      )}
      <div onClick={() => window.open(PURCHASE_URL, "_blank")} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <span style={{ fontSize: isBanner ? 11 : 18 }}>🦉</span>
        <span style={{ fontSize: isBanner ? 9 : 11, color: "#a5b4fc", fontWeight: 700, whiteSpace: "nowrap" }}>
          Go ad-free
        </span>
        <span style={{ fontSize: isBanner ? 9 : 10, color: "#6366f1", whiteSpace: "nowrap" }}>
          GangOwl Desktop — $11.99
        </span>
      </div>
    </div>
  );
}

// ── Main ad slot component ──
export default function AdSlot({ variant = "sidebar" }) {
  if (isDesktop) return null;

  const isBanner = variant === "banner";
  const h = isBanner ? 28 : 180;
  const slot = SLOTS[variant];
  const [adLoaded, setAdLoaded] = useState(false);
  const containerRef = useRef(null);

  // Check if the ad actually rendered after a delay
  useEffect(() => {
    if (!slot) return;
    const timer = setTimeout(() => {
      const el = containerRef.current;
      if (!el) return;
      const ins = el.querySelector(".adsbygoogle");
      if (ins && (ins.querySelector("iframe") || ins.offsetHeight > 5)) {
        setAdLoaded(true);
      }
    }, 3500);
    return () => clearTimeout(timer);
  }, [slot]);

  return (
    <div ref={containerRef} style={{
      height: h, minHeight: h, maxHeight: h,
      overflow: "hidden", flexShrink: 0, position: "relative",
      ...(isBanner ? { width: "100%", borderBottom: "1px solid #1f1e30" } : { margin: 8 }),
    }}>
      {/* Fallback always present behind */}
      <div style={{ position: "absolute", inset: 0, zIndex: 0 }}>
        <Fallback variant={variant} />
      </div>
      {/* Real ad on top — if it loads it covers the fallback */}
      {slot && (
        <div style={{ position: "relative", zIndex: 1, height: h, overflow: "hidden" }}>
          <AdUnit slot={slot} style={{ height: h }} format={isBanner ? "horizontal" : "rectangle"} />
        </div>
      )}
    </div>
  );
}

// ── Export interstitial ad ──
export function ExportAd({ onClose }) {
  const [countdown, setCountdown] = useState(5);
  const slot = SLOTS.export;

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
        <div style={{ height: 250, position: "relative", overflow: "hidden" }}>
          {/* Fallback behind */}
          <div style={{ position: "absolute", inset: 0, zIndex: 0 }}>
            <Fallback variant="sidebar" />
          </div>
          {/* Real ad on top */}
          {slot && (
            <div style={{ position: "relative", zIndex: 1, height: 250, overflow: "hidden" }}>
              <AdUnit slot={slot} style={{ height: 250 }} format="rectangle" />
            </div>
          )}
        </div>
        <div style={{ marginTop: 16, fontSize: 11, color: "#3d3b60" }}>
          {countdown > 0 ? `Continuing in ${countdown}s…` : "Done!"}
        </div>
      </div>
    </div>
  );
}
