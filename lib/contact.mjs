// Treat unqualified North American numbers alike, and require a country code elsewhere.
export function contactAddress(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length > 254) return null;
  const [local, domain, ...extra] = text.split('@');
  if (domain && !extra.length && local.length <= 64 &&
      /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local) &&
      domain.includes('.') && domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    return {kind:'email', address:text.toLowerCase()};
  }
  if (!/^\+?[\d\s().-]+$/.test(text)) return null;
  let digits = text.replace(/\D/g,'');
  if (!text.startsWith('+')) {
    if (digits.length === 10) digits = '1' + digits;
    else if (!/^1\d{10}$/.test(digits)) return null;
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return {kind:'sms',address:'+'+digits};
}
