// Adapted from LoanServe's sms-provider-factory.ts and webhooks/twilio-request.ts (MIT).
import twilio from 'twilio';
import { SmsProviderError } from './provider-errors.mjs';

export function twilioProvider(env=process.env, createClient=twilio) {
  const accountSid=env.DAYBOOK_TWILIO_ACCOUNT_SID?.trim();
  const token=env.DAYBOOK_TWILIO_AUTH_TOKEN?.trim();
  const service=env.DAYBOOK_TWILIO_MESSAGING_SERVICE_SID?.trim();
  const from=env.DAYBOOK_TWILIO_FROM_NUMBER?.trim();
  if (!accountSid && !token && !service && !from) return null;
  if (!/^AC[a-f0-9]{32}$/i.test(accountSid||'') || !token || (!service && !from) ||
      (service && !/^MG[a-f0-9]{32}$/i.test(service)) || (from && !/^\+[1-9]\d{7,14}$/.test(from))) {
    throw new Error('Invalid Daybook Twilio settings. Configure the account, auth token, and a messaging service or sender number.');
  }
  let client;
  return {
    async send({to,body,statusCallback}) {
      try {
        client ??= createClient(accountSid,token,{timeout:25_000,autoRetry:false});
        const message=await client.messages.create({to,body,statusCallback,
          ...(service?{messagingServiceSid:service}:{}),...(from?{from}:{})});
        if (!/^SM[0-9a-f]{32}$/i.test(message.sid)) throw new Error('Missing message SID');
        return {messageId:message.sid,status:message.status};
      } catch (error) { throw new SmsProviderError(error); }
    },
    verifies(url,signature,fields) {
      if (!signature || fields.AccountSid!==accountSid) return false;
      try { return twilio.validateRequest(token,signature,url,fields); } catch { return false; }
    },
  };
}
