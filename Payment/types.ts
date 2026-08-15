export interface PaymentTransaction {
  amount: number;
  merchantId: string;
  paidAt: number;
  paymentType: string;
  status: string;
  transactionId: string;
}

export type GopayQrisTransaction = PaymentTransaction;

export interface TransactionQuery {
  endTime: Date;
  startTime: Date;
}

export type GopayTransactionQuery = TransactionQuery;
