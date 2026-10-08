export interface EmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

export interface EmailAdapter {
  send(input: EmailInput): Promise<{ id: string }>;
}
