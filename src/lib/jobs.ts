/**
 * Queue names + payload types shared by web (enqueue) and worker (execute).
 * (ARCHITECTURE §Worker.)
 */

export const QUEUES = {
  DOCUMENT_GENERATE: "document.generate",
  SMS_SEND: "sms.send",
  EMAIL_SEND: "email.send",
  ALERTS_SCAN: "alerts.scan",
  BILLING_SWEEP: "billing.sweep",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const ALL_QUEUES: QueueName[] = Object.values(QUEUES);

export type DocumentKind =
  | "grn"
  | "waybill"
  | "invoice"
  | "supplier_statement"
  | "customer_statement";

export type DocumentGenerateJob = {
  kind: DocumentKind;
  /** The business row the document is generated from (purchase, dispatch, invoice, supplier, customer). */
  refId: string;
  orgId: string;
};

export type SmsSendJob = {
  orgId: string;
  /** International format without +, e.g. 2348012345678. */
  to: string;
  body: string;
};

export type EmailSendJob = {
  orgId: string;
  to: string;
  subject: string;
  html: string;
};

export type AlertsScanJob = Record<string, never>;

export type BillingSweepJob = Record<string, never>;

export type JobPayloads = {
  [QUEUES.DOCUMENT_GENERATE]: DocumentGenerateJob;
  [QUEUES.SMS_SEND]: SmsSendJob;
  [QUEUES.EMAIL_SEND]: EmailSendJob;
  [QUEUES.ALERTS_SCAN]: AlertsScanJob;
  [QUEUES.BILLING_SWEEP]: BillingSweepJob;
};
