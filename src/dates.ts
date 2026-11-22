/**
 * Fechas para ARCA.
 *
 * ARCA trabaja en hora de Argentina (UTC-3, sin horario de verano) y espera
 * las fechas del comprobante como `YYYYMMDD`. Calcular el "hoy" con la hora
 * local del servidor es un bug clasico: un server en UTC despues de las 21:00
 * ART ya esta en el dia siguiente y el comprobante sale con fecha futura.
 */

const ART_OFFSET_MS = 3 * 3600 * 1000;

/** "Hoy" en Argentina, como YYYY-MM-DD. */
export function todayArg(now: Date = new Date()): string {
  return new Date(now.getTime() - ART_OFFSET_MS).toISOString().slice(0, 10);
}

/** "Hoy" en Argentina en el formato de ARCA: YYYYMMDD. */
export function todayArcaDate(now: Date = new Date()): string {
  return toArcaDate(todayArg(now));
}

/** "2026-11-21" -> "20261121" */
export function toArcaDate(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`Fecha invalida: ${ymd}`);
  return ymd.replace(/-/g, "");
}

/** "20261121" -> "2026-11-21" */
export function fromArcaDate(arca: string): string {
  if (!/^\d{8}$/.test(arca)) throw new Error(`Fecha ARCA invalida: ${arca}`);
  return `${arca.slice(0, 4)}-${arca.slice(4, 6)}-${arca.slice(6, 8)}`;
}

/** Date (medianoche UTC) desde YYYYMMDD, o null si no es una fecha valida. */
export function arcaDateToDate(arca: string | undefined): Date | null {
  if (!arca || !/^\d{8}$/.test(arca)) return null;
  return new Date(`${fromArcaDate(arca)}T00:00:00.000Z`);
}

/** ISO-8601 con offset -03:00, formato que exige el TRA de WSAA. */
export function isoArgentina(d: Date): string {
  const t = new Date(d.getTime() - ART_OFFSET_MS);
  return t.toISOString().replace(/\.\d{3}Z$/, "-03:00");
}

/** Diferencia en dias entre dos fechas YYYYMMDD (a - b). */
export function diffArcaDays(a: string, b: string): number {
  const ms = (s: string) =>
    Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  return Math.round((ms(a) - ms(b)) / 86400000);
}
