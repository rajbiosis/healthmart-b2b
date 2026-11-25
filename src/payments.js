import { HttpError } from './util.js';

/**
 * Payment gateway options. Phase 1 runs with `manual`: the admin confirms payment.
 * Online gateways are registered here but stay disabled until they are switched on
 * (planned for after the free launch period). Enabling one needs its keys and webhook secret.
 */
const PROVIDERS = {
  manual: {
    name: 'manual',
    online: false,
    async checkout(order) {
      return {
        provider: 'manual',
        message: 'Payment की पुष्टि होने के बाद admin plan activate करेगा।',
        order_id: order.id,
      };
    },
  },
  razorpay: {
    name: 'razorpay',
    online: true,
    enabled: false,
    async checkout() {
      throw new HttpError(501, 'Online payment अभी चालू नहीं है');
    },
  },
  cashfree: {
    name: 'cashfree',
    online: true,
    enabled: false,
    async checkout() {
      throw new HttpError(501, 'Online payment अभी चालू नहीं है');
    },
  },
};

export function getPaymentProvider(name = process.env.PAYMENT_PROVIDER ?? 'manual') {
  const p = PROVIDERS[name];
  if (!p) throw new HttpError(500, `अज्ञात payment provider: ${name}`);
  return p;
}

export function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({ name: p.name, online: p.online, enabled: p.enabled ?? true }));
}
