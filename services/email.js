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

module.exports = { sendEmail, sendLeadAck, sendQuoteWithBookingLink, sendAppointmentConfirmation, sendContractLink };
