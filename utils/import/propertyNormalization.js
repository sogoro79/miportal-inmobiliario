import { tipoInmuebleSchema } from "../propertySchemas.js";

const propertyTypes = new Map(Object.entries({
  apartment: "apartamento", flat: "piso", house: "casa",
  country_house: "casa_campo", casa_de_campo: "casa_campo"
}));
const conditions = new Map(Object.entries({
  no_informado: "no_informado",
  obra_nueva: "obra_nueva", new: "obra_nueva", segunda_mano: "segunda_mano",
  used: "segunda_mano", resale: "segunda_mano", second_hand: "segunda_mano"
}));

export function normalizedKey(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function normalizeCrmPropertyType(value) {
  const key = normalizedKey(value);
  const type = propertyTypes.get(key) || key;
  return tipoInmuebleSchema.options.includes(type) ? type : undefined;
}

export function normalizeCrmCondition(value) {
  return conditions.get(normalizedKey(value));
}
