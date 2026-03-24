// Edition detection and license management
export const isDesktop = !!(window.__TAURI_INTERNALS__);
export const isWeb = !isDesktop;

const LICENSE_STORAGE_KEY = "gangowl-license";

// ── Gumroad product ID ──
// This is the product_id from the license key module on your Gumroad content page.
// Replace with the actual ID shown when you expand the license key module.
// It looks like "SDGgCnivv6gTTHfVRfUBxQ==" (NOT the permalink "duydqm")
const GUMROAD_PRODUCT_ID = "0FM6MaQXsIIYF6JZCNX_aw==";

// Developer key for testing — bypasses Gumroad API
const DEV_KEY = "GANGOWL-DEV-2026-TAKEOWL";

export function getSavedLicense() {
  try {
    const data = localStorage.getItem(LICENSE_STORAGE_KEY);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

export function saveLicense(data) {
  localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(data));
}

export function clearLicense() {
  localStorage.removeItem(LICENSE_STORAGE_KEY);
}

export async function verifyLicense(licenseKey) {
  // Dev key bypass
  if (licenseKey === DEV_KEY) {
    return { valid: true, licenseKey, email: "dev@take-owl.com", uses: 0, purchaseId: "dev" };
  }

  const res = await fetch("https://api.gumroad.com/v2/licenses/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      product_id: GUMROAD_PRODUCT_ID,
      license_key: licenseKey,
      increment_uses_count: "true",
    }),
  });

  if (!res.ok) {
    throw new Error("Invalid license key. Please check and try again.");
  }

  const data = await res.json();

  if (!data.success) {
    throw new Error("Invalid license key. Please check and try again.");
  }

  // Check if refunded or disputed
  if (data.purchase?.refunded) {
    throw new Error("This purchase has been refunded.");
  }
  if (data.purchase?.disputed) {
    throw new Error("This purchase is under dispute.");
  }

  return {
    valid: true,
    licenseKey,
    email: data.purchase?.email || "",
    uses: data.uses,
    purchaseId: data.purchase?.id || "",
  };
}

export const PURCHASE_URL = "https://zcpersonal.gumroad.com/l/duydqm";

// ── Desktop file save with native dialog ──
export async function saveFileWithDialog(blob, defaultName) {
  if (isDesktop) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const ext = defaultName.split(".").pop();
      const filters = {
        png: [{ name: "PNG Image", extensions: ["png"] }],
        jpg: [{ name: "JPEG Image", extensions: ["jpg", "jpeg"] }],
        webp: [{ name: "WebP Image", extensions: ["webp"] }],
        pdf: [{ name: "PDF Document", extensions: ["pdf"] }],
        gangowl: [{ name: "GangOwl Project", extensions: ["gangowl"] }],
      };
      const path = await save({ defaultPath: defaultName, filters: filters[ext] || [] });
      if (!path) return false; // user cancelled
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await writeFile(path, bytes);
      return true;
    } catch {
      // Tauri plugins not available — fall back to web download
    }
  }
  // Web fallback
  const url = URL.createObjectURL(blob);
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    window.open(url, "_blank");
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}
