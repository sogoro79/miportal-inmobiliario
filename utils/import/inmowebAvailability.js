// Provider schedule is local civil time, including Madrid DST transitions.
const madridHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" });
export const INMOWEB_UNAVAILABLE = "INMOWEB_TEMPORARILY_UNAVAILABLE";
export const INMOWEB_UNAVAILABLE_MESSAGE = "InmoWeb no está disponible para una nueva consulta en este momento. Puedes volver a simular cuando la fuente esté disponible.";
export function inmowebAvailable(at = Date.now()) {
  const hour = Number(madridHour.format(new Date(at)));
  return hour >= 18 || hour < 9;
}
