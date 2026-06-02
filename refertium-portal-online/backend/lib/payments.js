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
          name: `Refertium ${payment.month}`,
          description: `${user.name || user.username || user.id} - monthly access`
        }
      }
    }],
    metadata: {
      refertiumPaymentId: payment.linkId,
      userId: user.id,
      month: payment.month
    },
    payment_intent_data: {
      metadata: {
        refertiumPaymentId: payment.linkId,
        userId: user.id,
        month: payment.month
      }
    }
  };
}

module.exports = {
  checkoutSessionParams,
  normalizePaymentAmount,
  paymentMonthKey,
  signPaymentPayload,
  signedPaymentUrl,
  stripeUnitAmount
};
