// Ported from LoanServe's server/communications/sms/provider-errors.ts (MIT).
const refusals = new Map([
  ['21610','The recipient has opted out of texts from this sender.'],
  ['21211','The recipient number is invalid.'],
  ['21614','The recipient number does not accept mobile texts.'],
  ['21612','The recipient cannot be reached from this sender.'],
  ['21408','This sender is not enabled for that region.'],
]);

export function smsFailureReason(code) {
  if (refusals.has(code)) return refusals.get(code);
  if (code === '20429') return 'Twilio is limiting requests. Try again later.';
  if (code && /^\d{1,6}$/.test(code)) return 'Twilio reported error '+code+'.';
  return 'Twilio did not confirm the text.';
}

export class SmsProviderError extends Error {
  constructor(error) {
    // Twilio error messages can quote the destination and body. Retain only its numeric code.
    const status = Number(error?.status);
    const code = status < 500 && /^\d{1,6}$/.test(String(error?.code)) ? String(error.code) : null;
    super(smsFailureReason(code));
    this.code = code;
    this.uncertain = !(status >= 400 && status < 500);
  }
}
