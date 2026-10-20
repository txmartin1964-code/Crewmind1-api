/**
 * db/appointments.js
 * Owns: All database queries for appointments and available_slots tables.
 * Does NOT own: confirmation email sending (services/), HTTP handling (routes/).
 */

const pool = require('./index');
const crypto = require('crypto');

function generateConfirmationCode() {
  return 'CM' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Daily estimate-visit windows offered to customers. Times are labels in
// the business's local time (slot_time is stored/served as a plain string).
const SLOT_TIMES = ['08:00', '10:00', '13:00', '15:00'];

/**
 * Tops up available_slots so the next `businessDays` business days
 * (Mon–Fri, starting today) each have every SLOT_TIMES window available.
 * Idempotent: existing (slot_date, slot_time) rows are skipped, so it is
 * safe to run at every startup and on demand from the admin console.
 * Returns { inserted, business_days, max_bookings }.
 */
async function ensureUpcomingSlots({ tenantId = 1, businessDays = 30, maxBookings = 2 } = {}) {
  const result = await pool.query(
    `WITH biz_days AS (
       SELECT d::date AS slot_date
       FROM generate_series(CURRENT_DATE, CURRENT_DATE + INTERVAL '62 days', INTERVAL '1 day') AS d
       WHERE EXTRACT(ISODOW FROM d) < 6
       ORDER BY d
       LIMIT $2
     )
     INSERT INTO available_slots (tenant_id, slot_date, slot_time, max_bookings)
     SELECT $3, b.slot_date, t.slot_time, $1
     FROM biz_days b
     CROSS JOIN (VALUES ('08:00'), ('10:00'), ('13:00'), ('15:00')) AS t(slot_time)
     WHERE NOT EXISTS (
       SELECT 1 FROM available_slots s
       WHERE s.tenant_id = $3 AND s.slot_date = b.slot_date AND s.slot_time = t.slot_time
     )
     RETURNING id`,
    [maxBookings, businessDays, tenantId]
  );
  return { inserted: result.rows.length, business_days: businessDays, max_bookings: maxBookings };
}

async function getAvailableSlots(fromDate, toDate, tenantId = 1) {
  const result = await pool.query(
    `SELECT slot_date, slot_time, max_bookings, current_bookings
     FROM available_slots
     WHERE tenant_id=$3
       AND slot_date BETWEEN $1 AND $2
       AND is_blocked = FALSE
       AND current_bookings < max_bookings
     ORDER BY slot_date, slot_time`,
    [fromDate, toDate, tenantId]
  );
  return result.rows;
}

async function bookSlot(slotDate, slotTime, leadId, quoteId, tenantId = 1) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock and check the slot (within this tenant's own calendar)
    const slotRes = await client.query(
      `SELECT * FROM available_slots
       WHERE tenant_id=$3 AND slot_date=$1 AND slot_time=$2 AND is_blocked=FALSE AND current_bookings < max_bookings
       FOR UPDATE`,
      [slotDate, slotTime, tenantId]
    );

    if (!slotRes.rows.length) {
      throw new Error('Slot no longer available');
    }

    // Increment bookings
    await client.query(
      `UPDATE available_slots SET current_bookings=current_bookings+1 WHERE tenant_id=$3 AND slot_date=$1 AND slot_time=$2`,
      [slotDate, slotTime, tenantId]
    );

    const code = generateConfirmationCode();

    // Create appointment
    const apptRes = await client.query(
      `INSERT INTO appointments (tenant_id, lead_id, quote_id, scheduled_date, scheduled_time, confirmation_code)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [tenantId, leadId, quoteId || null, slotDate, slotTime, code]
    );

    // Update lead status
    await client.query(
      `UPDATE leads SET status='booked', updated_at=NOW() WHERE id=$1`,
      [leadId]
    );

    await client.query('COMMIT');
    return apptRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getAppointmentByCode(code) {
  const result = await pool.query(
    `SELECT a.*, l.name, l.email, l.phone, l.job_type, l.address, q.total_cents
     FROM appointments a
     JOIN leads l ON l.id = a.lead_id
     LEFT JOIN quotes q ON q.id = a.quote_id
     WHERE a.confirmation_code = $1`,
    [code]
  );
  return result.rows[0] || null;
}

async function markConfirmationSent(apptId) {
  await pool.query(
    'UPDATE appointments SET confirmation_sent_at=NOW() WHERE id=$1',
    [apptId]
  );
}

async function getUpcomingAppointments(tenantId = 1) {
  const result = await pool.query(
    `SELECT a.*, l.name, l.email, l.phone, l.job_type, l.address, q.total_cents
     FROM appointments a
     JOIN leads l ON l.id = a.lead_id
     LEFT JOIN quotes q ON q.id = a.quote_id
     WHERE a.tenant_id=$1 AND a.scheduled_date >= CURRENT_DATE AND a.status='confirmed'
     ORDER BY a.scheduled_date, a.scheduled_time
     LIMIT 30`,
    [tenantId]
  );
  return result.rows;
}

async function getAppointmentById(id) {
  const result = await pool.query('SELECT * FROM appointments WHERE id=$1', [id]);
  return result.rows[0] || null;
}

module.exports = { getAvailableSlots, bookSlot, getAppointmentByCode, getAppointmentById, markConfirmationSent, getUpcomingAppointments, ensureUpcomingSlots, SLOT_TIMES };
