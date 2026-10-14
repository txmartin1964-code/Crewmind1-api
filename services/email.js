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

// Resend delivers directly; there is no contact-registration step.
// Kept as a no-op so existing call sites don't change.
async function registerContact() {
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
 */
async function sendQuoteWithBookingLink(lead, quote, bookingUrl) {
  const totalDollars = (quote.total_cents / 100).toFixed(2);
  const subject = `Your estimate is ready — Book your appointment`;
  const body = `Hi ${lead.name},\n\nYour estimate for ${lead.job_type.replace(/_/g, ' ')} is ready.\n\nEstimated total: $${totalDollars}\nValid for 14 days.\n\nBook your free on-site estimate here:\n${bookingUrl}\n\n— CrewMind`;
  const html = `
Hi ${lead.name},<br><br>
Your estimate for <strong>${lead.job_type.replace(/_/g, ' ')}</strong> is ready.<br><br>
<strong>Estimated Total: $${totalDollars}</strong><br>
Valid for 14 days.<br><br>
<a href="${bookingUrl}">Book your free on-site estimate →</a><br><br>
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

module.exports = { sendEmail, registerContact, sendLeadAck, sendQuoteWithBookingLink, sendAppointmentConfirmation };
