// Edition detection and license management
export const isDesktop = !!(window.__TAURI_INTERNALS__);
export const isWeb = !isDesktop;

const LICENSE_KEY = "gangowl-license";
const GUMROAD_PRODUCT_ID = "duydqm";

export function getSavedLicense() {
  try {
    const data = localStorage.getItem(LICENSE_KEY);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

export function saveLicense(data) {
  localStorage.setItem(LICENSE_KEY, JSON.stringify(data));
}

export function clearLicense() {
  localStorage.removeItem(LICENSE_KEY);
}

export async function verifyLicense(email) {
  try {
    const res = await fetch("https://api.gumroad.com/v2/sales", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        product_id: GUMROAD_PRODUCT_ID,
        email: email,
      }),
    });
    // Gumroad sales API requires seller auth — use license verify instead
    // Fall back to a simpler check: verify via the public product endpoint
    if (!res.ok) throw new Error("Verification failed");
    const data = await res.json();
    if (data.success) {
      return { valid: true, email };
    }
    throw new Error("No purchase found");
  } catch {
    // Fallback: use Gumroad's license verification endpoint
    try {
      const res = await fetch("https://api.gumroad.com/v2/licenses/verify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          product_id: GUMROAD_PRODUCT_ID,
          license_key: email, // user might paste a license key
        }),
      });
      const data = await res.json();
      if (data.success) {
        return { valid: true, email, uses: data.uses };
      }
    } catch {}
    throw new Error("Could not verify purchase. Check your email or license key.");
  }
}

export const PURCHASE_URL = "https://zcpersonal.gumroad.com/l/duydqm";
