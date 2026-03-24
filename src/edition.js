// Edition detection and license management
export const isDesktop = !!(window.__TAURI_INTERNALS__);
export const isWeb = !isDesktop;

const LICENSE_STORAGE_KEY = "gangowl-license";

// ── Gumroad product ID ──
// This is the product_id from the license key module on your Gumroad content page.
// Replace with the actual ID shown when you expand the license key module.
// It looks like "SDGgCnivv6gTTHfVRfUBxQ==" (NOT the permalink "duydqm")
const GUMROAD_PRODUCT_ID = "0FM6MaQXsIIYF6JZCNX_aw==";

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
