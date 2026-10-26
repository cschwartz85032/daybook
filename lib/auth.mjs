import { randomBytes, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function passwordHash(password, salt) {
  return (await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
}
export async function verifyPassword(password, user) {
  const calculated = await passwordHash(password, user?.salt || 'daybook-unknown-account');
  const expected = user?.password_hash || '0'.repeat(128);
  return timingSafeEqual(Buffer.from(calculated, 'hex'), Buffer.from(expected, 'hex')) && !!user;
}
