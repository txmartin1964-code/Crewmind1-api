/**
 * services/email.js
 *
 * Owns: Email sending via Resend (https://resend.com).
 *
 * Env:
 *   RESEND_API_KEY - required. Get one at https://resend.com/api-keys
 *                    (free tier: 3,000 emails/month).
 *   EMAIL_FROM     - optional sender identity, e.g. "CrewMind <quotes@yourdomain.com>".
 *                    Defaults to Resend's onboarding address for testing.
 *                    Verify a domain in Resend to send from your own address.
 */

const RESEND_API = 'https://api.resend.com/emails';

function getFrom() {
  return process.env.EMAIL_FROM || 'CrewMind <onboarding@resend.dev>';
}

async function sendEmail({ to, subject, body, html, reply_to }) {
  const payload = {
    from: getFrom(),
    to: Array.isArray(to) ? to : [to],
    subject,
  };

  if (html) {
    payload.html = html;
    if (body) payload.text = body;
  } else {
    payload.text = body || '';
  }

  if (reply_to) payload.reply_to = reply_to;

  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('[email] send failed:', res.status, err);

    // Non-fatal — log and continue
    return { ok: false, error: err };
  }

  return { ok: true };
}

/**
 * Sends a lead submission acknowledgement to the homeowner.
 */
async function sendLeadAck(lead) {
  const subject = `We received your ${lead.job_type.replace(/_/g, ' ')} request`;
  const body = `Hi ${lead.name},\n\nThanks for reaching out to us. We've received your request and our team is reviewing it now.\n\nYou'll hear from us within 24 hours with a quote and available appointment times.\n\nJob type: ${lead.job_type.replace(/_/g, ' ')}\nAddress: ${lead.address}\n\n— CrewMind`;
  const html = `
Hi ${lead.name},<br><br>
Thanks for reaching out. We've received your <strong>${lead.job_type.replace(/_/g, ' ')}</strong> request and our team is reviewing it now.<br><br>
You'll hear from us within 24 hours with a quote and available appointment times.<br><br>
— CrewMind
`;

  return sendEmail({ to: lead.email, subject, body, html });
}

/**
 * Sends quote + booking link to the homeowner.
 * payment (optional): { url, deposit_cents } — when present, a
 * "Pay deposit" section is included alongside the booking link.
 */
async function sendQuoteWithBookingLink(lead, quote, bookingUrl, payment) {
  const totalDollars = (quote.total_cents / 100).toFixed(2);
  const subject = `Your estimate is ready — Book your appointment`;

  let paymentText = '';
  let paymentHtml = '';
  if (payment && payment.url && payment.deposit_cents > 0) {
    const depositDollars = (payment.deposit_cents / 100).toFixed(2);
    paymentText = `\nReserve your spot with a deposit of $${depositDollars}:\n${payment.url}\n`;
    paymentHtml = `<strong>Deposit due: $${depositDollars}</strong><br><a href="${payment.url}">Pay deposit →</a><br><br>`;
  }

  const body = `Hi ${lead.name},\n\nYour estimate for ${lead.job_type.replace(/_/g, ' ')} is ready.\n\nEstimated total: $${totalDollars}\nValid for 14 days.\n${paymentText}\nBook your free on-site estimate here:\n${bookingUrl}\n\n— CrewMind`;
  const html = `
Hi ${lead.name},<br><br>
Your estimate for <strong>${lead.job_type.replace(/_/g, ' ')}</strong> is ready.<br><br>
<strong>Estimated Total: $${totalDollars}</strong><br>
Valid for 14 days.<br><br>
${paymentHtml}<a href="${bookingUrl}">Book your free on-site estimate →</a><br><br>
This estimate is valid for 14 days. Pricing may be adjusted after the on-site visit.<br><br>
— CrewMind
`;

  return sendEmail({ to: lead.email, subject, body, html });
}

/**
 * Sends appointment confirmation to the homeowner.
 */
async function sendAppointmentConfirmation(appt, lead, confirmUrl) {
  const dateStr = new Date(appt.scheduled_date).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const timeStr = appt.scheduled_time.slice(0, 5);
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h || 12;
  const timeDisplay = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  const subject = `Confirmed: On-site estimate ${dateStr}`;
  const body = `Hi ${lead.name || appt.name},\n\nYour estimate appointment is confirmed!\n\nDate: ${dateStr}\nTime: ${timeDisplay}\nAddress: ${appt.address}\nConfirmation code: ${appt.confirmation_code}\n\nWe'll see you then.\n\n— CrewMind`;
  const html = `
Hi ${lead.name || appt.name},<br><br>
Your estimate appointment is confirmed!<br><br>
<strong>Date:</strong> ${dateStr}<br>
<strong>Time:</strong> ${timeDisplay}<br>
<strong>Address:</strong> ${appt.address}<br>
<strong>Confirmation:</strong> ${appt.confirmation_code}<br><br>
Need to reschedule? Reply to this email or call us directly.<br><br>
— CrewMind
`;

  return sendEmail({ to: lead.email || appt.email, subject, body, html });
}

/**
 * Sends the customer the link to view and sign their contract.
 * payment (optional): { url, deposit_cents } — when present and the
 * deposit is unpaid, a "Pay deposit" line is included too.
 */
async function sendContractLink(contract, signUrl, payment) {
  const totalDollars = (contract.total_cents / 100).toFixed(2);
  const subject = `Your contract is ready to sign — ${contract.contract_number}`;

  let paymentText = '';
  let paymentHtml = '';
  if (payment && payment.url && payment.deposit_cents > 0) {
    const depositDollars = (payment.deposit_cents / 100).toFixed(2);
    paymentText = `\nYour deposit of $${depositDollars} can be paid here:\n${payment.url}\n`;
    paymentHtml = `Your deposit of <strong>$${depositDollars}</strong> can be paid here:<br><a href="${payment.url}">Pay deposit →</a><br><br>`;
  }

  const body = `Hi ${contract.customer_name},\n\nYour service agreement (${contract.contract_number}) for ${contract.title} is ready.\n\nTotal: $${totalDollars}\n\nReview and sign it here:\n${signUrl}\n${paymentText}\n— CrewMind`;
  const html = `
Hi ${contract.customer_name},<br><br>
Your service agreement (<strong>${contract.contract_number}</strong>) for ${contract.title} is ready.<br><br>
<strong>Total: $${totalDollars}</strong><br><br>
<a href="${signUrl}">Review and sign your contract →</a><br><br>
${paymentHtml}— CrewMind
`;

  return sendEmail({ to: contract.customer_email, subject, body, html });
}

/**
 * Sends the customer their final invoice with the balance pay link.
 * invoice: row from db/invoices.js. payUrl: the stable redirector URL.
 */
async function sendFinalInvoice(lead, invoice, payUrl, businessName) {
  const due = (invoice.amount_due_cents / 100).toFixed(2);
  const total = (invoice.total_cents / 100).toFixed(2);
  const deposit = (invoice.deposit_paid_cents / 100).toFixed(2);
  const from = businessName || 'CrewMind';
  const subject = `Your final invoice ${invoice.invoice_number || ''} — balance $${due}`.trim();
  const body = `Hi ${lead.name},\n\nYour job is complete — thank you!\n\nFinal invoice ${invoice.invoice_number || ''}\nJob total: $${total}\nDeposit paid: $${deposit}\nBalance due: $${due}\n\nPay securely here:\n${payUrl}\n\nQuestions? Just reply to this email.\n\n— ${from}`;
  const html = `
Hi ${lead.name},<br><br>
Your job is complete — thank you!<br><br>
<strong>Final invoice ${invoice.invoice_number || ''}</strong><br>
Job total: $${total}<br>
Deposit paid: $${deposit}<br>
<strong>Balance due: $${due}</strong><br><br>
<a href="${payUrl}">Pay your balance →</a><br><br>
Questions? Just reply to this email.<br><br>
— ${from}
`;
  return sendEmail({ to: lead.email, subject, body, html });
}

/**
 * Sends the customer the approval link for a change order (Item 5).
 */
async function sendChangeOrderLink(lead, changeOrder, signUrl, businessName) {
  const from = businessName || 'CrewMind';
  const amount = (changeOrder.amount_cents / 100).toFixed(2);
  const subject = `Approval needed: change order — $${amount}`;
  const body = `Hi ${lead.name},\n\n${from} has a change order for your job that needs your approval:\n\n${changeOrder.description}\n\nAmount: $${amount} (added to your final invoice only if you approve)\n\nReview and sign here:\n${signUrl}\n\n— ${from}`;
  const html = `
Hi ${lead.name},<br><br>
${from} has a change order for your job that needs your approval:<br><br>
<em>${changeOrder.description}</em><br><br>
<strong>Amount: $${amount}</strong> — added to your final invoice only if you approve.<br><br>
<a href="${signUrl}">Review and sign →</a><br><br>
— ${from}
`;
  return sendEmail({ to: lead.email, subject, body, html });
}

/**
 * Review request (Item 6): asks how the job went, with BOTH paths side
 * by side — "Share on Google" and "Tell us privately" — for every
 * customer, no sentiment gating. googleUrl may be null (tenant has not
 * set their review link yet); the private path always works.
 */
async function sendReviewRequest(lead, { googleUrl, feedbackUrl, businessName }) {
  const from = businessName || 'CrewMind';
  const subject = `How did we do? — ${from}`;
  const googleLine = googleUrl
    ? `\nShare your experience on Google:\n${googleUrl}\n`
    : '';
  const googleHtml = googleUrl
    ? `<a href="${googleUrl}" style="display:inline-block;padding:12px 20px;background:#ffb347;color:#1a1206;border-radius:8px;text-decoration:none;font-weight:700;margin-right:10px;">Share on Google</a>`
    : '';
  const body = `Hi ${lead.name},\n\nThanks for choosing ${from}. We'd love to hear how the job went — it takes about a minute.\n${googleLine}\nPrefer to tell us directly? We read every note:\n${feedbackUrl}\n\nEither way, thank you.\n\n— ${from}`;
  const html = `
Hi ${lead.name},<br><br>
Thanks for choosing ${from}. We'd love to hear how the job went — it takes about a minute.<br><br>
${googleHtml}<a href="${feedbackUrl}" style="display:inline-block;padding:12px 20px;background:#232833;color:#e8eaed;border:1px solid #333a47;border-radius:8px;text-decoration:none;font-weight:700;">Tell us privately</a><br><br>
Either way, thank you.<br><br>
— ${from}
`;
  return sendEmail({ to: lead.email, subject, body, html });
}

/** Thank-you sent after a customer submits private feedback. */
async function sendFeedbackThanks(lead, businessName) {
  const from = businessName || 'CrewMind';
  const subject = `Thank you for your feedback — ${from}`;
  const body = `Hi ${lead.name},\n\nThank you for telling us how the job went. We read every note, and yours helps us do better work.\n\n— ${from}`;
  const html = `Hi ${lead.name},<br><br>Thank you for telling us how the job went. We read every note, and yours helps us do better work.<br><br>— ${from}`;
  return sendEmail({ to: lead.email, subject, body, html });
}

module.exports = { sendEmail, sendLeadAck, sendQuoteWithBookingLink, sendAppointmentConfirmation, sendContractLink, sendFinalInvoice, sendReviewRequest, sendFeedbackThanks, sendChangeOrderLink };
