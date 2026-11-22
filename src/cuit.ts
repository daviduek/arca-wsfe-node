/** Valida un CUIT de 11 digitos, incluido el digito verificador. */
export function isValidCuit(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(cuit[i]), 0);
  let dv = 11 - (sum % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9;
  return dv === Number(cuit[10]);
}

/** Quita guiones, puntos y espacios: "20-12345678-9" -> "20123456789". */
export function normalizeCuit(input: string): string {
  return input.replace(/[^\d]/g, "");
}

/** "20123456789" -> "20-12345678-9" */
export function formatCuit(cuit: string): string {
  const c = normalizeCuit(cuit);
  if (c.length !== 11) return cuit;
  return `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`;
}

/** Tipos de documento de ARCA mas usados (tabla FEParamGetTiposDoc). */
export const DOC_TIPOS = {
  CUIT: 80,
  CUIL: 86,
  DNI: 96,
  /** Consumidor final: exige DocNro = "0". */
  CONSUMIDOR_FINAL: 99,
} as const;

/**
 * Condiciones de IVA del receptor (RG 5616, tabla
 * FEParamGetCondicionIvaReceptor). Los ids se validan igual contra la tabla
 * que devuelve ARCA, porque pueden cambiar.
 */
export const COND_IVA_RECEPTOR = {
  RESPONSABLE_INSCRIPTO: 1,
  EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
  MONOTRIBUTO: 6,
} as const;
