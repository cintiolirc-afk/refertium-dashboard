const crypto = require('crypto');

function paymentMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function normalizePaymentAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('Prezzo mensile non configurato');
    err.status = 400;
    throw err;
  }
  return amount;
}

function stripeUnitAmount(amount) {
  const unitAmount = Math.round(normalizePaymentAmount(amount) * 100);
  if (!Number.isInteger(unitAmount) || unitAmount <= 0) {
    const err = new Error('Importo Stripe non valido');
    err.status = 400;
    throw err;
  }
  return unitAmount;
}

function normalizeLimitPackage(value = {}, fallback = {}) {
  const tokenLimit = Number(value.tokenLimit == null ? fallback.tokenLimit || 0 : value.tokenLimit);
  const dictationHourLimit = Number(value.dictationHourLimit == null ? fallback.dictationHourLimit || 0 : value.dictationHourLimit);
  if (!Number.isFinite(tokenLimit) || tokenLimit < 0 || !Number.isFinite(dictationHourLimit) || dictationHourLimit < 0) {
    const err = new Error('Pacchetto limiti non valido');
    err.status = 400;
    throw err;
  }
  return {
    tokenLimit: Math.round(tokenLimit),
    dictationHourLimit: Math.round(dictationHourLimit * 100) / 100
  };
}

function signPaymentPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 24);
}

function signedPaymentUrl({ baseUrl, userId, month, amount, linkId, secret }) {
  const normalizedAmount = normalizePaymentAmount(amount);
  const payload = `${userId}:${month}:${normalizedAmount.toFixed(2)}:${linkId}`;
  const sig = signPaymentPayload(payload, secret);
  return `${baseUrl.replace(/\/$/, '')}?user=${encodeURIComponent(userId)}&month=${encodeURIComponent(month)}&amount=${encodeURIComponent(normalizedAmount.toFixed(2))}&ref=${encodeURIComponent(linkId)}&sig=${sig}`;
}

function checkoutSessionParams({ user, payment, currency, publicBaseUrl }) {
  const limitPackage = normalizeLimitPackage(payment.package || {}, user || {});
  const metadata = {
    refertiumPaymentId: payment.linkId,
    userId: user.id,
    month: payment.month,
    tokenLimit: String(limitPackage.tokenLimit),
    dictationHourLimit: String(limitPackage.dictationHourLimit)
  };
  return {
    mode: 'payment',
    customer_email: user.email || undefined,
    client_reference_id: payment.linkId,
    success_url: `${publicBaseUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${publicBaseUrl}/?payment=cancelled`,
    line_items: [{
      quantity: 1,
      price_data: {
        currency,
        unit_amount: stripeUnitAmount(payment.amount),
        product_data: {
          name: `Refertium limit package ${payment.month}`,
          description: `${user.name || user.username || user.id} - ${limitPackage.tokenLimit} tokens, ${limitPackage.dictationHourLimit} dictation hours`
        }
      }
    }],
    metadata,
    payment_intent_data: {
      metadata
    }
  };
}

module.exports = {
  checkoutSessionParams,
  normalizeLimitPackage,
  normalizePaymentAmount,
  paymentMonthKey,
  signPaymentPayload,
  signedPaymentUrl,
  stripeUnitAmount
};
