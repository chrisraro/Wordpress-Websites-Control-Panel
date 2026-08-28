import { describe, it, expect } from "vitest";
import { parseGeoGridConfigForm } from "@/services/geogrid/config-input";

function form(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    business_name: "Test Cafe",
    place_ref: "",
    keywords: "coffee shop, espresso bar",
    grid_size: "5",
    spacing_m: "1000",
    center_lat: "14.5995",
    center_lng: "120.9842",
    provider: "stub",
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) fd.set(k, v);
  return fd;
}

describe("parseGeoGridConfigForm", () => {
  it("parses a valid submission", () => {
    const res = parseGeoGridConfigForm(form());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toEqual({
      business_name: "Test Cafe",
      place_ref: null,
      keywords: ["coffee shop", "espresso bar"],
      grid_size: 5,
      spacing_m: 1000,
      center_lat: 14.5995,
      center_lng: 120.9842,
      provider: "stub",
    });
  });

  it("trims and dedupes keywords", () => {
    const res = parseGeoGridConfigForm(form({ keywords: " a , b ,a,, b " }));
    if (!res.ok) throw new Error("unreachable");
    expect(res.value.keywords).toEqual(["a", "b"]);
  });

  it("returns a friendly error instead of crashing when formData is missing", () => {
    // Regression: useActionState passes (prevState, formData); a mis-bound
    // action handed `null` here and threw "Cannot read properties of null".
    for (const bad of [null, undefined, {}, "nope", 42]) {
      const res = parseGeoGridConfigForm(bad);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable");
      expect(res.error).toMatch(/form data missing/i);
    }
  });

  it("rejects each invalid field with a specific message", () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ business_name: "  " }, /business name/i],
      [{ keywords: " , ," }, /at least one keyword/i],
      [{ keywords: Array.from({ length: 11 }, (_, i) => `k${i}`).join(",") }, /ten keywords/i],
      [{ grid_size: "4" }, /grid size/i],
      [{ grid_size: "" }, /grid size/i],
      [{ spacing_m: "50" }, /spacing/i],
      [{ spacing_m: "999999" }, /spacing/i],
      [{ spacing_m: "abc" }, /spacing/i],
      [{ center_lat: "91" }, /latitude/i],
      [{ center_lng: "-181" }, /longitude/i],
      [{ center_lat: "" }, /latitude/i],
      [{ provider: "dataforseo" }, /provider/i],
    ];
    for (const [over, pattern] of cases) {
      const res = parseGeoGridConfigForm(form(over));
      expect(res.ok, `expected ${JSON.stringify(over)} to fail`).toBe(false);
      if (res.ok) throw new Error("unreachable");
      expect(res.error).toMatch(pattern);
    }
  });

  it("keeps a place reference when given and defaults the provider", () => {
    const res = parseGeoGridConfigForm(form({ place_ref: " ChIJ123 ", provider: "" }));
    if (!res.ok) throw new Error("unreachable");
    expect(res.value.place_ref).toBe("ChIJ123");
    expect(res.value.provider).toBe("stub");
  });
});
