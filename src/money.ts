// decimal.js expone la clase como export nombrado (y tambien como default, por
// interop). Con "module": "NodeNext" hay que importarla asi.
import { Decimal } from "decimal.js";

export { Decimal };

/** Cualquier cosa que esta libreria acepta como importe. */
export type MoneyInput = string | number | Decimal;

/**
 * Convierte a Decimal. Nunca uses `number` con decimales para dinero: 0.1 + 0.2
 * no da 0.3 y ARCA rechaza el comprobante cuando los totales no cuadran al
 * centavo.
 */
export const D = (v: MoneyInput): Decimal => new Decimal(v);

export const ZERO = new Decimal(0);

/** Redondeo a 2 decimales con half-up, que es lo que espera ARCA. */
export function round2(v: Decimal): Decimal {
  return v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Importe con exactamente 2 decimales y punto como separador: "1234.56". */
export function money(v: MoneyInput): string {
  return D(v).toFixed(2);
}

export function sumMoney(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(D(v)), ZERO);
}
