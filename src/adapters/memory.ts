/**
 * Adapters en memoria.
 *
 * Sirven para un script, un CLI, los tests o un proceso unico. NO sirven para
 * una app con varias instancias ni para serverless:
 *
 * - el Ticket de Acceso no se comparte entre instancias y WSAA va a rechazar
 *   el segundo login con `coe.alreadyAuthenticated`;
 * - el lock no serializa nada fuera de este proceso;
 * - el registro de intentos se pierde al reiniciar, y con el la posibilidad de
 *   conciliar un comprobante que quedo en duda.
 *
 * Para produccion implementa las interfaces de `./types.js` sobre tu base de
 * datos. En el README hay un ejemplo con Postgres.
 */
import { randomUUID } from "node:crypto";
import type {
  ArcaAdapters,
  AttemptStore,
  CachedParams,
  IssueAttempt,
  Lock,
  NewIssueAttempt,
  ParamCache,
  StoredTicket,
  TicketStore,
} from "./types.js";

export class MemoryTicketStore implements TicketStore {
  private map = new Map<string, StoredTicket>();
  async get(key: string): Promise<StoredTicket | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, ticket: StoredTicket): Promise<void> {
    this.map.set(key, ticket);
  }
}

/**
 * Mutex por nombre, dentro de este proceso.
 *
 * Cada llamada se encola detras de la anterior sobre el mismo nombre. La cola
 * nunca se rompe por un error de `fn`: el turno se libera en el `finally`.
 */
export function createInProcessLock(): Lock {
  const tails = new Map<string, Promise<void>>();

  return async function lock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(name) ?? Promise.resolve();

    let release!: () => void;
    const myTurn = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = previous.then(() => myTurn);
    tails.set(name, tail);

    await previous; // nunca rechaza: solo se resuelve cuando el anterior libero

    try {
      return await fn();
    } finally {
      release();
      // Si nadie se encolo detras, no dejamos la entrada colgada.
      if (tails.get(name) === tail) tails.delete(name);
    }
  };
}

export class MemoryAttemptStore implements AttemptStore {
  private items: IssueAttempt[] = [];

  async create(attempt: NewIssueAttempt): Promise<IssueAttempt> {
    const row: IssueAttempt = {
      ...attempt,
      id: randomUUID(),
      status: "PENDIENTE",
      createdAt: new Date(),
      resolvedAt: null,
    };
    this.items.push(row);
    return row;
  }

  async findUnresolved(key: {
    cuit: string;
    ptoVta: number;
    cbteTipo: number;
  }): Promise<IssueAttempt | null> {
    const found = this.items
      .filter(
        (a) =>
          a.cuit === key.cuit &&
          a.ptoVta === key.ptoVta &&
          a.cbteTipo === key.cbteTipo &&
          (a.status === "PENDIENTE" || a.status === "AMBIGUO"),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return found[0] ?? null;
  }

  async update(
    id: string,
    patch: Partial<Pick<IssueAttempt, "status" | "resolvedAt" | "errorClass" | "errorDetail">>,
  ): Promise<void> {
    const row = this.items.find((a) => a.id === id);
    if (row) Object.assign(row, patch);
  }

  /** Solo para tests. */
  all(): readonly IssueAttempt[] {
    return this.items;
  }
}

export class MemoryParamCache implements ParamCache {
  private map = new Map<string, CachedParams>();
  async get(key: string): Promise<CachedParams | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: CachedParams): Promise<void> {
    this.map.set(key, value);
  }
  async clear(prefix?: string): Promise<void> {
    if (!prefix) return void this.map.clear();
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k);
  }
}

/** Set completo de adapters en memoria. Para pruebas y scripts. */
export function memoryAdapters(): ArcaAdapters {
  return {
    tickets: new MemoryTicketStore(),
    lock: createInProcessLock(),
    attempts: new MemoryAttemptStore(),
    params: new MemoryParamCache(),
  };
}
