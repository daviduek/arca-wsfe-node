/**
 * Puntos de extension de la libreria.
 *
 * El core no sabe nada de tu base de datos. Todo lo que necesita persistir o
 * serializar entra por estas interfaces. Los adapters en memoria
 * (`arca-wsfe/adapters/memory`) alcanzan para un script, un CLI o un proceso
 * unico; para una app real con varias instancias hace falta persistirlos.
 */

export interface StoredTicket {
  /** Token del Ticket de Acceso. Credencial sensible: guardalo cifrado. */
  token: string;
  /** Sign del Ticket de Acceso. Credencial sensible: guardalo cifrado. */
  sign: string;
  generationTime: Date;
  expirationTime: Date;
}

/**
 * Cache del Ticket de Acceso de WSAA.
 *
 * WSAA entrega un TA que dura 12 horas y rechaza pedir otro mientras el
 * anterior siga vigente (error `coe.alreadyAuthenticated`). Si cada instancia
 * de tu app guarda el TA en su propia memoria, la segunda instancia no puede
 * autenticarse. Por eso en produccion el TA se comparte: Postgres, Redis, lo
 * que uses.
 *
 * Los valores son credenciales: cifralos antes de escribirlos.
 */
export interface TicketStore {
  get(key: string): Promise<StoredTicket | null>;
  set(key: string, ticket: StoredTicket): Promise<void>;
}

/**
 * Lock con exclusion mutua entre todos los procesos que comparten un CUIT.
 *
 * Serializa dos cosas: el login en WSAA y la emision por
 * (CUIT, punto de venta, tipo de comprobante). La numeracion de ARCA es
 * secuencial y sin huecos: dos emisiones en paralelo pueden pedir el mismo
 * numero y una va a fallar, o peor, duplicar.
 *
 * En una sola instancia basta un mutex en memoria. Con varias instancias
 * necesitas un lock real: `pg_advisory_xact_lock` en Postgres o un lock en
 * Redis.
 */
export type Lock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export type AttemptStatus =
  /** Se persistio el intento; todavia no se sabe el resultado. */
  | "PENDIENTE"
  /** Hubo timeout o error de red: no se sabe si ARCA autorizo. Conciliar. */
  | "AMBIGUO"
  /** ARCA autorizo y devolvio CAE. */
  | "EXITO"
  /** Se confirmo por conciliacion que el comprobante ya existia en ARCA. */
  | "CONCILIADO"
  /** No se emitio: rechazo o error definitivo. */
  | "FALLIDO";

export interface IssueAttempt {
  id: string;
  cuit: string;
  ptoVta: number;
  cbteTipo: number;
  cbteNro: number;
  /** Total con 2 decimales, para verificar en la conciliacion. */
  total: string;
  /** SHA-256 del XML enviado, para detectar reenvios distintos. */
  requestHash: string;
  /**
   * Identificador de la venta en el sistema del llamador (id de factura, de
   * orden). Es la clave de la idempotencia: permite reconocer que un intento
   * colgado corresponde a la misma venta que se esta intentando emitir.
   */
  externalId?: string | null;
  status: AttemptStatus;
  createdAt: Date;
  resolvedAt?: Date | null;
  errorClass?: string | null;
  errorDetail?: string | null;
}

export type NewIssueAttempt = Omit<IssueAttempt, "id" | "status" | "createdAt" | "resolvedAt">;

/**
 * Registro de intentos de emision. Es lo que hace segura la emision.
 *
 * El intento se escribe ANTES de llamar a FECAESolicitar. Si la llamada muere
 * por timeout no hay forma de saber desde el cliente si ARCA autorizo o no: el
 * intento guardado es lo que permite despues preguntarle a ARCA por ese numero
 * exacto y decidir si hay que emitir o no.
 *
 * Con el store en memoria eso se pierde al reiniciar el proceso: usalo solo
 * para pruebas.
 */
export interface AttemptStore {
  create(attempt: NewIssueAttempt): Promise<IssueAttempt>;
  /** Ultimo intento en PENDIENTE o AMBIGUO para esa clave, si hay alguno. */
  findUnresolved(key: {
    cuit: string;
    ptoVta: number;
    cbteTipo: number;
  }): Promise<IssueAttempt | null>;
  update(
    id: string,
    patch: Partial<Pick<IssueAttempt, "status" | "resolvedAt" | "errorClass" | "errorDetail">>,
  ): Promise<void>;
}

export interface CachedParams {
  rows: Record<string, string>[];
  fetchedAt: Date;
}

/**
 * Cache de las tablas de parametros de WSFE (tipos de comprobante, de IVA,
 * puntos de venta, condiciones de IVA del receptor). Cambian muy poco; ARCA
 * pide no consultarlas en cada emision.
 */
export interface ParamCache {
  get(key: string): Promise<CachedParams | null>;
  set(key: string, value: CachedParams): Promise<void>;
  clear(prefix?: string): Promise<void>;
}

export interface ArcaAdapters {
  tickets: TicketStore;
  lock: Lock;
  attempts: AttemptStore;
  params: ParamCache;
}
