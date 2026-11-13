// Local evidence only. Scores are ranking points, not calibrated probabilities.
const normalize = value => String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const safe = value => String(value ?? "").replace(/<[^>]*>/g, " ")
  .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\S+@\S+|\S*[?&=]\S*/gi, "[omitido]")
  .replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 200);
const labels = ["PROBABLEMENTE NUEVA", "POSIBLE DUPLICADA", "SEGURAMENTE DUPLICADA"];

function similarity(a, b, min, pairs = false) {
  function tokens(value) {
    const words = normalize(value).split(" ").filter(w => w.length > 2);
    return new Set(pairs ? words.slice(1).map((w, i) => words[i] + " " + w) : words);
  }
  const x = tokens(a), y = tokens(b);
  if (Math.min(x.size, y.size) < min) return 0;
  return 2 * [...x].filter(w => y.has(w)).length / (x.size + y.size);
}

function compare(a, b) {
  let points = 0;
  const reasons = [];
  const families = new Set();
  function add(family, condition, weight, reason) {
    if (condition) {
      points += weight;
      reasons.push(reason);
      families.add(family);
    }
    return Boolean(condition);
  }
  const eq = key => normalize(a[key]) !== "" && normalize(a[key]) === normalize(b[key]);
  const num = key => Number.isFinite(a[key]) && a[key] > 0 && a[key] === b[key];
  const photos = p => [...new Set((p.imagenes || []).filter(url => typeof url === "string" && /^https?:\/\//i.test(url)))];
  const x = photos(a), y = photos(b), common = x.filter(photo => y.includes(photo)).length;
  const primary = common && x[0] === y[0];
  add("visual", common, common >= 2 ? 38 : primary ? 32 : 24,
    [primary && "misma imagen principal", common + " URL de foto coincidente(s)",
      common && common === x.length && common === y.length && "mismo conjunto de fotos"].filter(Boolean).join(", "));
  const desc = similarity(a.descripcion, b.descripcion, 6, true);
  add("textual", desc >= 0.65, desc >= 0.82 ? 28 : 18, "descripción " + Math.round(desc * 100) + "% similar");
  const title = similarity(a.titulo, b.titulo, 3);
  add("textual", title >= 0.75, 8, "título " + Math.round(title * 100) + "% similar");
  add("location_commercial", num("precio"), 9, "mismo precio");
  add("location_commercial", eq("localidad"), 7, "misma localidad");
  add("location_commercial", eq("provincia"), 3, "misma provincia");
  const area = add("structural", num("superficie"), 13, "mismos m² construidos");
  const plot = add("structural", num("superficieParcela"), 10, "misma parcela");
  const beds = add("structural", num("habitaciones"), 5, "mismos dormitorios");
  const baths = add("structural", num("banos"), 4, "mismos baños");
  add("structural", eq("tipoInmueble"), 3, "mismo tipo");
  add("structural", eq("tipoOperacion"), 2, "misma operación");
  add("location_commercial", eq("ubicacionPublica") && ![normalize(a.localidad), normalize(a.provincia)].includes(normalize(a.ubicacionPublica)), 3, "misma ubicación pública");
  const features = ["piscina", "terraza", "garaje"].filter(k => a[k] === true && b[k] === true);
  add("structural", features.length, features.length, "coinciden " + features.join(", "));
  add("reference", eq("referencia"), 1, "misma referencia normalizada");
  const conflict = ["localidad", "tipoOperacion", "provincia"].some(k => normalize(a[k]) && normalize(b[k]) && !eq(k));
  const priceChanged = a.precio > 0 && b.precio > 0 && !num("precio");
  if (conflict) reasons.push("discrepancia de ubicación u operación");
  if (priceChanged) reasons.push("precio distinto");
  const anchor = common || desc >= 0.82 || (area && plot && (beds || baths));
  const independentFamilies = families.size - Number(families.has("reference"));
  const diverse = independentFamilies >= 2 &&
    (families.has("visual") || families.has("textual") || families.has("structural"));
  const strong = diverse && points >= 65 && anchor && !conflict && (!priceChanged || common >= 2);
  const possible = diverse && points >= 24 && (common || desc >= 0.65 || area || plot || title >= 0.75);
  return { rank: strong ? 2 : possible ? 1 : 0, points, reasons, evidenceFamilies: [...families],
    candidate: { _id: String(b._id), referencia: safe(b.referencia), titulo: safe(b.titulo) } };
}

export function duplicateReport(incoming, existing) {
  const rows = incoming.map(a => {
    const matches = existing.map(b => compare(a, b)).sort((x, y) => y.rank - x.rank || y.points - x.points ||
      x.candidate._id.localeCompare(y.candidate._id));
    const best = matches[0];
    const alternatives = best?.rank ? matches.slice(1).filter(m => m.rank === best.rank && best.points - m.points <= 5) : [];
    const rank = alternatives.length ? 1 : best?.rank || 0;
    return { externalId: safe(a.externalId), referenciaCRM: safe(a.referencia), tituloNormalizado: normalize(safe(a.titulo)),
      precio: a.precio ?? null, localidad: safe(a.localidad), provincia: safe(a.provincia), m2: a.superficie ?? null,
      dormitorios: a.habitaciones ?? null, banos: a.banos ?? null, fotos: a.imagenes?.length ?? 0,
      clasificacion: labels[rank], confianzaCoincidencia: ["baja", "media", "alta"][rank], puntos: best?.points ?? 0,
      evidenceFamilies: best?.evidenceFamilies ?? [],
      candidata: rank ? best.candidate : null, alternativas: alternatives.map(m => m.candidate),
      razones: [...(best?.reasons || []), ...(!rank ? ["Sin combinación significativa"] : []),
        ...(alternatives.length ? ["Varios candidatos con evidencia similar"] : [])] };
  });
  return { totalNEW: rows.length, resumen: Object.fromEntries(labels.map(label => [label, rows.filter(r => r.clasificacion === label).length])), filas: rows };
}
