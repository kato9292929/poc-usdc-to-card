// PSP（PAY.JP）とのやりとりの型。モックと本物が同じ形を実装する

export interface Charge {
  id: string;
  amount: number;
  amount_refunded: number;
  captured: boolean;
  refunded: boolean;
  currency: string;
  metadata: Record<string, string>;
  created: number;
  captured_at?: number | null;
  expired_at?: number | null;
  three_d_secure_status?: string | null;
}

export interface Psp {
  readonly name: string;
  /** buyer 役：テストカードからトークンを作る（1 回しか使えない） */
  createToken(): Promise<string>;
  /** 与信（capture=false） */
  authorize(o: { amount: number; token: string; metadata: Record<string, string> }): Promise<Charge>;
  /** 確定。amount を付けると与信額より少なく確定できる。1 回だけ */
  capture(id: string, amount?: number): Promise<Charge>;
  /** 未確定の与信の取り消し（全額） */
  release(id: string): Promise<Charge>;
  /** since（Unix 秒）以降の charge を全件 */
  listCharges(since: number): Promise<Charge[]>;
  /** これまでに PSP の API を呼んだ回数（種類別） */
  readonly calls: Record<string, number>;
}

export class PspError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 3D セキュアを求められて与信が通らなかった */
export class AuthenticationRequired extends Error {}
