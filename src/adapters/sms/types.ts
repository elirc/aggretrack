export interface SmsAdapter {
  /** Send one SMS. `to` is an international number, with or without leading `+`. */
  send(to: string, body: string): Promise<{ id: string }>;
}
