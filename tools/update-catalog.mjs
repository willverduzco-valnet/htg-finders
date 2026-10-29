// static/update-catalog.ts
import fs3 from "node:fs";
import path2 from "node:path";

// static/catalog.ts
import fs from "node:fs";
import path from "node:path";

// src/lib/recommend.ts
function isServable(c2) {
  return c2.is_active && c2.status === "active" && c2.markets.includes("personal") && c2.networks.length > 0;
}

// static/catalog.ts
async function copyLogo(outDir, publicDir, slug, url) {
  if (!url) return null;
  if (url.startsWith("logos/")) return fs.existsSync(path.join(outDir, url)) ? url : null;
  fs.mkdirSync(path.join(outDir, "logos"), { recursive: true });
  if (url.startsWith("/")) {
    const src = publicDir ? path.join(publicDir, url.split("?")[0]) : "";
    if (!src || !fs.existsSync(src)) return null;
    const file = `logos/${slug}${path.extname(src)}`;
    fs.copyFileSync(src, path.join(outDir, file));
    return file;
  }
  if (!/^https?:\/\//.test(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    const ext = type.includes("svg") ? "svg" : type.includes("webp") ? "webp" : type.includes("jpeg") ? "jpg" : "png";
    const file = `logos/${slug}.${ext}`;
    fs.writeFileSync(path.join(outDir, file), Buffer.from(await res.arrayBuffer()));
    return file;
  } catch {
    return null;
  }
}
function sameBody(prev2, body) {
  const { built_at: _b, ...rest } = prev2;
  void _b;
  return JSON.stringify(rest) === JSON.stringify(body);
}
async function writeCatalog(src, outDir, publicDir) {
  const overrides = src.overrides ?? {};
  const carriers = [];
  let logos = 0;
  for (const c2 of src.carriers.filter(isServable)) {
    const o = overrides[c2.slug] ?? {};
    const logo = await copyLogo(outDir, publicDir, c2.slug, c2.logo_url);
    if (logo) logos++;
    carriers.push({
      ...c2,
      is_promoted: c2.is_promoted || o.is_promoted === true,
      promoted_rank: o.promoted_rank ?? c2.promoted_rank,
      logo_url: logo ?? c2.logo_url,
      notes: null,
      research_notes: null,
      sources: [],
      plans: c2.plans.filter((p) => p.is_active)
    });
  }
  const isps = [];
  for (const i of src.isps) {
    const logo = await copyLogo(outDir, publicDir, `isp-${i.slug}`, i.logo_url);
    isps.push({ ...i, logo_url: logo ?? i.logo_url, research_notes: null, sources: [], plans: i.plans.filter((p) => p.is_active) });
  }
  const body = { coverage_as_of: src.coverageAsOf, availability_as_of: src.availabilityAsOf, carriers, networks: src.networks, settings: src.settings, isps };
  const file = path.join(outDir, "data/catalog.json");
  const prev2 = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const changed = !prev2 || !sameBody(prev2, body);
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ built_at: (/* @__PURE__ */ new Date()).toISOString(), ...body }));
  }
  return { source: src.source, changed, carriers: carriers.length, logos, isps: isps.length };
}

// static/sheet-api.ts
import crypto from "node:crypto";
import fs2 from "node:fs";
var cached = null;
function serviceKey() {
  const raw = process.env.GOOGLE_SA_KEY || (process.env.GOOGLE_SA_KEY_FILE ? fs2.readFileSync(process.env.GOOGLE_SA_KEY_FILE, "utf8") : "");
  if (!raw) throw new Error("Set GOOGLE_SA_KEY or GOOGLE_SA_KEY_FILE to a service account key that can open the sheet.");
  return JSON.parse(raw);
}
async function token() {
  if (cached && cached.exp > Date.now() + 6e4) return cached.token;
  const key = serviceKey();
  const now = Math.floor(Date.now() / 1e3);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = { iss: key.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` })
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`Google sign-in failed: ${body.error ?? res.status}`);
  cached = { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1e3 };
  return cached.token;
}
async function sheets(path3, init = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path3}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : void 0
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Sheets ${init.method ?? "GET"} ${path3.split("?")[0]}: ${res.status} ${json.error?.message ?? ""}`);
  return json;
}
async function readTabs(id2, titles) {
  const q = titles.map((t) => `ranges=${encodeURIComponent(`'${t}'`)}`).join("&");
  const r = await sheets(`${id2}/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE`);
  const out2 = {};
  r.valueRanges.forEach((v, i) => out2[titles[i]] = v.values ?? []);
  return out2;
}

// static/sheet-schema.ts
var c = (key, header, type = "text", extra = {}) => ({ key, header, type, ...extra });
var NETS = ["att", "tmobile", "verizon"];
var TECHS = ["fiber", "cable", "dsl", "fixed_wireless", "5g_home", "satellite_leo", "satellite_geo"];
var TABS = [
  {
    name: "Carriers",
    note: "One row per cell carrier. Active = shown in the finder. Promoted = can be the Featured pick (rank breaks ties).",
    cols: [
      c("slug", "Slug (don't change)", "text", { width: 150 }),
      c("name", "Name", "text", { width: 160 }),
      c("type", "Type", "text", { options: ["mno", "mvno"] }),
      c("status", "Status", "text", { options: ["active", "defunct", "acquired", "unknown"] }),
      c("is_active", "Active", "bool"),
      c("markets", "Markets", "list"),
      c("network_mode", "Network mode", "text", { options: ["single", "choose", "switch"] }),
      c("is_promoted", "Promoted", "bool"),
      c("promoted_rank", "Promoted rank", "num"),
      c("is_favorite", "Our favorite", "bool"),
      c("favorite_note", "Favorite note"),
      c("website", "Website", "text", { width: 220 }),
      c("affiliate_base_url", "Affiliate link", "text", { width: 220 }),
      c("affiliate_extension", "Affiliate extension"),
      c("coverage_map_url", "Coverage map URL", "text", { width: 200 }),
      c("tagline", "Tagline", "text", { width: 220 }),
      c("description", "Description", "text", { width: 300 }),
      c("highlights", "Highlights", "list", { width: 300 }),
      c("requirements", "Requirements", "text", { width: 220 }),
      c("family_discounts", "Family discounts", "text", { width: 220 }),
      c("smartwatch_notes", "Smartwatch notes", "text", { width: 220 }),
      c("roaming_notes", "Roaming notes", "text", { width: 220 }),
      c("status_notes", "Status notes", "text", { width: 200 }),
      c("logo_url", "Logo file"),
      c("logo_dark_bg", "Logo on dark tile", "bool"),
      c("confidence", "Research confidence", "text", { options: ["high", "medium", "low"] }),
      c("verified_at", "Verified on"),
      c("id", "ID (don't change)", "text", { width: 120 })
    ]
  },
  {
    name: "Carrier networks",
    note: "Which networks each carrier uses and what it gets on them. Priority is a short note shown to visitors.",
    cols: [
      c("carrier", "Carrier slug", "text", { width: 150 }),
      c("network_id", "Network", "text", { options: NETS }),
      c("lte", "4G LTE", "bool"),
      c("nr", "5G", "bool"),
      c("premium_5g", "Premium 5G", "bool"),
      c("priority", "Priority note", "text", { width: 260 }),
      c("notes", "Notes", "text", { width: 260 })
    ]
  },
  {
    name: "Cell plans",
    note: "One row per plan. Prices are per month for one line unless noted. Leave a cell blank when unknown.",
    cols: [
      c("carrier", "Carrier slug", "text", { width: 150 }),
      c("name", "Plan", "text", { width: 180 }),
      c("is_active", "Active", "bool"),
      c("price_monthly", "Price / mo", "num"),
      c("intro_price_monthly", "Intro price / mo", "num"),
      c("billing_term_months", "Billing term (months)", "num"),
      c("upfront_cost", "Upfront cost", "num"),
      c("autopay_required", "Autopay required", "bool"),
      c("multi_line", "Per-line price by lines (2:25 | 3:20)", "tiers", { width: 200 }),
      c("max_lines", "Max lines", "num"),
      c("line_pricing_extends", "Last line price extends", "bool"),
      c("line_pricing_notes", "Line pricing notes", "text", { width: 200 }),
      c("unlimited", "Unlimited", "bool"),
      c("data_gb", "Data GB", "num"),
      c("high_speed_gb", "Full-speed GB (unlimited)", "num"),
      c("deprioritization_gb", "May slow after GB", "num"),
      c("priority_data_gb", "Priority data GB (-1 = unlimited)", "num"),
      c("priority_networks", "Priority only on", "nets"),
      c("throttle_speed_after", "Speed after cap"),
      c("hotspot_gb", "Hotspot GB (-1 unlimited, 0 none)", "num"),
      c("five_g", "5G", "bool"),
      c("premium_5g", "Premium 5G", "bool"),
      c("video_quality", "Video quality"),
      c("international", "International calling", "text", { width: 200 }),
      c("perks", "Perks", "list", { width: 260 }),
      c("postpaid", "Postpaid", "bool"),
      c("ends_on", "Promo ends on (YYYY-MM-DD)"),
      c("watch_available", "Watch lines", "opt"),
      c("watch_price", "Watch price / mo", "num"),
      c("watch_apple", "Apple Watch", "opt"),
      c("watch_android", "Android watch", "opt"),
      c("watch_networks", "Watch only on", "nets"),
      c("watch_notes", "Watch notes", "text", { width: 200 }),
      c("roam_cm_included", "Canada/Mexico included", "opt"),
      c("roam_cm_high_speed_gb", "Canada/Mexico high-speed GB", "num"),
      c("roam_cm_addon_monthly", "Canada/Mexico add-on / mo", "num"),
      c("roam_cm_addon_daily", "Canada/Mexico add-on / day", "num"),
      c("roam_cm_payg", "Canada/Mexico pay as you go", "opt"),
      c("roam_networks", "Roaming only on", "nets"),
      c("roam_cm_notes", "Canada/Mexico notes", "text", { width: 200 }),
      c("roam_global_included", "Global roaming included", "opt"),
      c("roam_global_speed", "Global speed", "text", { options: ["full", "throttled"] }),
      c("roam_global_throttle_kbps", "Global throttled kbps", "num"),
      c("roam_global_high_speed_gb", "Global high-speed GB", "num"),
      c("roam_global_countries", "Global countries", "num"),
      c("roam_global_addon_daily", "Global add-on / day", "num"),
      c("roam_global_addon_monthly", "Global add-on / mo", "num"),
      c("roam_global_payg", "Global pay as you go", "opt"),
      c("roam_global_notes", "Global notes", "text", { width: 200 }),
      c("affiliate_url_override", "Plan affiliate link", "text", { width: 220 }),
      c("sort_order", "Sort order", "num"),
      c("id", "ID (don't change)", "text", { width: 120 })
    ]
  },
  {
    name: "Internet providers",
    note: "One row per home internet provider. FCC names/IDs connect it to the FCC availability data.",
    cols: [
      c("slug", "Slug (don't change)", "text", { width: 150 }),
      c("name", "Name", "text", { width: 170 }),
      c("status", "Status", "text", { options: ["active", "defunct", "acquired", "unknown"] }),
      c("is_active", "Active", "bool"),
      c("successor_slug", "Now sold as (slug)"),
      c("is_promoted", "Promoted", "bool"),
      c("promoted_rank", "Promoted rank", "num"),
      c("is_favorite", "Our favorite", "bool"),
      c("favorite_note", "Favorite note"),
      c("website", "Website", "text", { width: 220 }),
      c("availability_url", "Availability checker URL", "text", { width: 220 }),
      c("affiliate_base_url", "Affiliate link", "text", { width: 220 }),
      c("affiliate_extension", "Affiliate extension"),
      c("technologies", "Technologies", "list", { width: 160 }),
      c("fcc_provider_ids", "FCC provider IDs", "list"),
      c("fcc_names", "FCC names", "list", { width: 260 }),
      c("regional_pricing", "Regional pricing", "bool"),
      c("pricing_basis", "Pricing basis", "text", { width: 260 }),
      c("status_notes", "Status notes", "text", { width: 200 }),
      c("logo_url", "Logo file"),
      c("logo_dark_bg", "Logo on dark tile", "bool"),
      c("confidence", "Research confidence", "text", { options: ["high", "medium", "low"] }),
      c("verified_at", "Verified on"),
      c("id", "ID (don't change)", "text", { width: 120 })
    ]
  },
  {
    name: "Internet plans",
    note: "One row per home internet plan. Typical speeds as a range, e.g. 300-500.",
    cols: [
      c("isp", "Provider slug", "text", { width: 150 }),
      c("name", "Plan", "text", { width: 180 }),
      c("is_active", "Active", "bool"),
      c("technology", "Technology", "text", { options: TECHS }),
      c("download_mbps", "Download Mbps", "num"),
      c("upload_mbps", "Upload Mbps", "num"),
      c("typical_download_mbps", "Typical download (low-high)", "range"),
      c("typical_upload_mbps", "Typical upload (low-high)", "range"),
      c("price_monthly", "Regular price / mo", "num"),
      c("promo_price_monthly", "Promo price / mo", "num"),
      c("promo_months", "Promo months", "num"),
      c("price_lock_months", "Price lock months", "num"),
      c("contract_months", "Contract months", "num"),
      c("equipment_fee_monthly", "Equipment / mo", "num"),
      c("equipment_upfront", "Equipment upfront", "num"),
      c("installation_fee", "Installation fee", "num"),
      c("data_cap_gb", "Data cap GB (blank = none)", "num"),
      c("data_cap_notes", "Data cap notes", "text", { width: 200 }),
      c("latency_ms", "Latency ms", "num"),
      c("ends_on", "Promo ends on (YYYY-MM-DD)"),
      c("notes", "Notes", "text", { width: 240 }),
      c("affiliate_url_override", "Plan affiliate link", "text", { width: 220 }),
      c("sort_order", "Sort order", "num"),
      c("id", "ID (don't change)", "text", { width: 120 })
    ]
  },
  {
    name: "Bundles",
    note: "Home internet + cell discounts. Discount is per month; 'applies to' is the bill it comes off.",
    cols: [
      c("isp", "Provider slug", "text", { width: 150 }),
      c("carrier_slug", "Carrier slug", "text", { width: 150 }),
      c("discount_monthly", "Discount / mo", "num"),
      c("discount_applies_to", "Applies to", "text", { options: ["internet", "mobile", "both"] }),
      c("mobile_requires_internet", "Cell plan requires this internet", "bool"),
      c("eligible_internet_plans", "Eligible internet plans", "text", { width: 220 }),
      c("eligible_mobile_plans", "Eligible cell plans", "text", { width: 220 }),
      c("notes", "Notes", "text", { width: 260 }),
      c("source", "Source", "text", { width: 220 })
    ]
  },
  {
    name: "Networks",
    note: "The three cell networks.",
    cols: [
      c("id", "Network", "text"),
      c("name", "Name"),
      c("premium_5g_name", "Premium 5G name"),
      c("postpaid_map_url", "Postpaid map URL", "text", { width: 260 }),
      c("prepaid_map_url", "Prepaid map URL", "text", { width: 260 })
    ]
  },
  {
    name: "Settings",
    note: "Scoring weights for the cell finder. Change with care.",
    cols: [c("key", "Setting", "text", { width: 220 }), c("value", "Value", "num")]
  }
];
var blank = (v) => v === void 0 || v === null || v === "";
function fromCell(type, raw) {
  const s = raw === void 0 || raw === null ? "" : String(raw).trim();
  switch (type) {
    case "bool":
      return /^(yes|y|true|1)$/i.test(s);
    case "opt":
      return s === "" ? null : /^(yes|y|true|1)$/i.test(s);
    case "num": {
      if (s === "") return null;
      const n = Number(s.replace(/[$,]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "list":
      return s === "" ? [] : s.split("|").map((x) => x.trim()).filter(Boolean);
    case "nets": {
      const nets = s.split(/[,|]/).map((x) => x.trim().toLowerCase()).filter((x) => NETS.includes(x));
      return nets.length ? nets : null;
    }
    case "range": {
      const m = /^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/.exec(s);
      return m ? [Number(m[1]), Number(m[2])] : null;
    }
    case "tiers":
      return s === "" ? [] : s.split("|").map((t) => t.split(":").map((x) => Number(x.replace(/[$\s]/g, "")))).filter(([l, p]) => Number.isFinite(l) && Number.isFinite(p)).map(([lines, price_per_line]) => ({ lines, price_per_line }));
    default:
      return s === "" ? null : s;
  }
}
function valuesToRecords(t, values) {
  const keys = (values[1] ?? []).map((k) => String(k ?? "").trim());
  const first = t.cols[0].key;
  const out2 = [];
  for (const row of values.slice(2)) {
    const r = {};
    keys.forEach((k, i) => {
      const col = t.cols.find((x) => x.key === k);
      if (col) r[k] = fromCell(col.type, row[i]);
    });
    if (!blank(r[first])) out2.push(r);
  }
  return out2;
}
var without = (r, key) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));
var slugId = (...parts) => parts.join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function recordsToCatalog(rows) {
  const nets = rows["Carrier networks"] ?? [];
  const plans = rows["Cell plans"] ?? [];
  const carriers = (rows.Carriers ?? []).map((r) => {
    const id2 = r.id || slugId(r.slug);
    return {
      ...r,
      id: id2,
      notes: null,
      research_notes: null,
      sources: [],
      networks: nets.filter((n) => n.carrier === r.slug).map((n) => ({ ...without(n, "carrier"), network_id: n.network_id })),
      plans: plans.filter((p) => p.carrier === r.slug).map((p, i) => ({
        ...without(p, "carrier"),
        id: p.id || slugId(r.slug, p.name),
        carrier_id: id2,
        multi_line: p.multi_line ?? [],
        perks: p.perks ?? [],
        sort_order: p.sort_order ?? i
      }))
    };
  });
  const ispPlans = rows["Internet plans"] ?? [];
  const bundles = rows.Bundles ?? [];
  const isps = (rows["Internet providers"] ?? []).map((r) => {
    const id2 = r.id || r.slug;
    return {
      ...r,
      id: id2,
      research_notes: null,
      sources: [],
      mobile_bundles: bundles.filter((b) => b.isp === r.slug).map((b) => without(b, "isp")),
      plans: ispPlans.filter((p) => p.isp === r.slug).map((p, i) => ({
        ...without(p, "isp"),
        id: p.id || slugId(r.slug, p.name),
        isp_id: id2,
        contract_months: p.contract_months ?? 0,
        sort_order: p.sort_order ?? i
      }))
    };
  });
  const setting = new Map((rows.Settings ?? []).map((r) => [r.key, r.value]));
  const num = (k, d) => setting.get(k) ?? d;
  const settings = {
    home_weight: num("home_weight", 0.6),
    worst_location_weight: num("worst_location_weight", 0.2),
    tier_weights: { lte: num("tier_weights.lte", 0.55), nr: num("tier_weights.nr", 0.25), nr_plus: num("tier_weights.nr_plus", 0.2) },
    rank_weights: { coverage: num("rank_weights.coverage", 0.65), price: num("rank_weights.price", 0.35) },
    value_coverage_margin: num("value_coverage_margin", 12),
    min_coverage_to_show: num("min_coverage_to_show", 35),
    result_count: num("result_count", 10)
  };
  return { carriers, networks: rows.Networks ?? [], settings, isps };
}

// static/sheet-cli.ts
async function readCatalog(id2) {
  const values = await readTabs(id2, TABS.map((t) => t.name));
  const records = Object.fromEntries(TABS.map((t) => [t.name, valuesToRecords(t, values[t.name] ?? [])]));
  const catalog2 = recordsToCatalog(records);
  const problems2 = [];
  const carrierSlugs = new Set(catalog2.carriers.map((c2) => c2.slug));
  const ispSlugs = new Set(catalog2.isps.map((i) => i.slug));
  const dup = (list, what) => {
    const seen = /* @__PURE__ */ new Set();
    for (const s of list) {
      if (seen.has(s)) problems2.push(`Duplicate ${what}: ${s}`);
      seen.add(s);
    }
  };
  dup(catalog2.carriers.map((c2) => c2.slug), "carrier slug");
  dup(catalog2.isps.map((c2) => c2.slug), "provider slug");
  dup(catalog2.carriers.flatMap((c2) => c2.plans.map((p) => p.id)), "cell plan ID");
  dup(catalog2.isps.flatMap((c2) => c2.plans.map((p) => p.id)), "internet plan ID");
  for (const r of records["Cell plans"]) if (!carrierSlugs.has(r.carrier)) problems2.push(`Cell plan "${r.name}" points at unknown carrier "${r.carrier}"`);
  for (const r of records["Carrier networks"]) if (!carrierSlugs.has(r.carrier)) problems2.push(`Carrier network row for unknown carrier "${r.carrier}"`);
  for (const r of records["Internet plans"]) if (!ispSlugs.has(r.isp)) problems2.push(`Internet plan "${r.name}" points at unknown provider "${r.isp}"`);
  for (const r of records.Bundles) {
    if (!ispSlugs.has(r.isp)) problems2.push(`Bundle points at unknown provider "${r.isp}"`);
    if (!carrierSlugs.has(r.carrier_slug)) problems2.push(`Bundle points at unknown carrier "${r.carrier_slug}"`);
  }
  for (const c2 of catalog2.carriers) {
    if (c2.is_active && !c2.networks.length) problems2.push(`Active carrier ${c2.slug} has no networks`);
    for (const p of c2.plans) if (p.is_active && p.price_monthly == null) problems2.push(`Active plan ${c2.slug} / ${p.name} has no price`);
  }
  return { catalog: catalog2, problems: problems2 };
}

// static/update-catalog.ts
var id = process.env.FINDERS_SHEET_ID;
if (!id) throw new Error("Set FINDERS_SHEET_ID");
var out = process.cwd();
var prev = JSON.parse(fs3.readFileSync(path2.join(out, "data/catalog.json"), "utf8"));
var { catalog, problems } = await readCatalog(id);
for (const p of problems) console.log(`::warning::${p}`);
if (!catalog.carriers.length || !catalog.isps.length) throw new Error("The sheet came back without carriers or providers; not publishing.");
var summary = await writeCatalog(
  { source: "sheet", ...catalog, coverageAsOf: prev.coverage_as_of, availabilityAsOf: prev.availability_as_of },
  out,
  null
);
console.log("catalog:", summary);
