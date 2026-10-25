// Provider schedule is local civil time, including Madrid DST transitions.
const madridHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" });
export const INMOWEB_UNAVAILABLE = "INMOWEB_TEMPORARILY_UNAVAILABLE";
export const INMOWEB_UNAVAILABLE_MESSAGE = "No podemos actualizar InmoWeb en este momento. Inténtalo más tarde.";
export function inmowebAvailable(at = Date.now()) {
  const hour = Number(madridHour.format(new Date(at)));
  return hour >= 18 || hour < 9;
}
