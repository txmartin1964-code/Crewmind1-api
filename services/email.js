/**
 * services/email.js
 * Owns: Email sending via Polsia email proxy.
 * Does NOT own: template content decisions (caller's job), DB writes.
 */

const EMAIL_BASE = 'https://polsia.com/api/proxy/email';

async function sendEmail({ to, subject, body, html, reply_to_email_id }) {
  const payload = { to, subject, body };
  if (html) payload.html = html;
  if (reply_to_email_id) payload.reply_to_email_id = reply_to_email_id;

  const res = await fetch(`${EMAIL_BASE}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
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

async function registerContact({ email, name, source = 'contact_form' }) {
  try {
    await fetch(`${EMAIL_BASE}/contacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.POLSIA_API_KEY}`,
      },
      body: JSON.stringify({ email, name, source }),
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Sends a lead submission acknowledgement to the homeowner.
 */
async function sendLeadAck(lead) {
  const subject = `We received your ${lead.job_type.replace(/_/g, ' ')} request`;
  const body = `Hi ${lead.name},\n\nThanks for reaching out to us. We've received your request and our team is reviewing it now.\n\nYou'll hear from us within 24 hours with a quote and available appointment times.\n\nJob type: ${lead.job_type.replace(/_/g, ' ')}\nAddress: ${lead.address}\n\n— CrewMind`;
  const html = `<p>Hi ${lead.name},</p>
<p>Thanks for reaching out. We've received your <strong>${lead.job_type.replace(/_/g, ' ')}</strong> request and our team is reviewing it now.</p>
<p>You'll hear from us within 24 hours with a quote and available appointment times.</p>
<table style="font-family:sans-serif;font-size:14px;margin-top:16px;border-collapse:collapse;">
  <tr><td style="padding:4px 12px 4px 0;color:#888">Job type</td><td>${lead.job_type.replace(/_/g, ' ')}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#888">Address</td><td>${lead.address}</td></tr>
</table>
<p style="margin-top:24px;">— CrewMind</p>`;

  return sendEmail({ to: lead.email, subject, body, html });
}

/**
 * Sends quote + booking link to the homeowner.
 */
async function sendQuoteWithBookingLink(lead, quote, bookingUrl) {
  const totalDollars = (quote.total_cents / 100).toFixed(2);
  const subject = `Your estimate is ready — Book your appointment`;
  const body = `Hi ${lead.name},\n\nYour estimate for ${lead.job_type.replace(/_/g, ' ')} is ready.\n\nEstimated total: $${totalDollars}\nValid for 14 days.\n\nBook your free on-site estimate here:\n${bookingUrl}\n\n— CrewMind`;
  const html = `<p>Hi ${lead.name},</p>
<p>Your estimate for <strong>${lead.job_type.replace(/_/g, ' ')}</strong> is ready.</p>
<table style="font-family:sans-serif;font-size:15px;margin:16px 0;border-collapse:collapse;">
  <tr>
    <td style="padding:8px 20px 8px 0;color:#888">Estimated Total</td>
    <td style="font-size:1.4em;font-weight:700;color:#f59e0b">$${totalDollars}</td>
  </tr>
  <tr>
    <td style="padding:4px 20px 4px 0;color:#888">Valid until</td>
    <td>14 days from today</td>
  </tr>
</table>
<p>Book your free on-site estimate:</p>
<p style="margin:20px 0;">
  <a href="${bookingUrl}" style="background:#f59e0b;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">Book Appointment →</a>
</p>
<p style="color:#888;font-size:13px;">This estimate is valid for 14 days. Pricing may be adjusted after the on-site visit.</p>
<p style="margin-top:24px;">— CrewMind</p>`;

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
  const html = `<p>Hi ${lead.name || appt.name},</p>
<p>Your on-site estimate appointment is confirmed!</p>
<table style="font-family:sans-serif;font-size:14px;margin:16px 0;border-collapse:collapse;">
  <tr><td style="padding:6px 20px 6px 0;color:#888">Date</td><td style="font-weight:600">${dateStr}</td></tr>
  <tr><td style="padding:6px 20px 6px 0;color:#888">Time</td><td style="font-weight:600">${timeDisplay}</td></tr>
  <tr><td style="padding:6px 20px 6px 0;color:#888">Address</td><td>${appt.address}</td></tr>
  <tr><td style="padding:6px 20px 6px 0;color:#888">Confirmation</td><td style="font-family:monospace;background:#f5f5f5;padding:2px 6px;border-radius:4px">${appt.confirmation_code}</td></tr>
</table>
<p style="color:#888;font-size:13px;">Need to reschedule? Reply to this email or call us directly.</p>
<p style="margin-top:24px;">— CrewMind</p>`;

  return sendEmail({ to: lead.email || appt.email, subject, body, html });
}

module.exports = { sendEmail, registerContact, sendLeadAck, sendQuoteWithBookingLink, sendAppointmentConfirmation };
