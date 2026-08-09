/**
 * db/leads.js
 * Owns: All database queries for the leads table.
 * Does NOT own: qualification logic (services/), HTTP handling (routes/).
 */

const pool = require('./index');

async function createLead(data) {
  const { name, email, phone, job_type, address, city, zip, sqft, timeline, description, photo_urls, ip_address } = data;
  const result = await pool.query(
    `INSERT INTO leads (name, email, phone, job_type, address, city, zip, sqft, timeline, description, photo_urls, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [name, email, phone || null, job_type, address, city || null, zip || null,
     sqft || null, timeline || null, description || null,
     JSON.stringify(photo_urls || []), ip_address || null]
  );
  return result.rows[0];
}

async function updateLeadQualification(leadId, { ai_score, ai_reasoning, ai_flags, qualification_status, status }) {
  const result = await pool.query(
    `UPDATE leads
     SET ai_score=$1, ai_reasoning=$2, ai_flags=$3, qualification_status=$4, status=$5, updated_at=NOW()
     WHERE id=$6
     RETURNING *`,
    [ai_score, ai_reasoning, JSON.stringify(ai_flags || []), qualification_status, status, leadId]
  );
  return result.rows[0];
}

async function getLeadById(id) {
  const result = await pool.query('SELECT * FROM leads WHERE id=$1', [id]);
  return result.rows[0] || null;
}

async function getLeads({ status, limit = 50, offset = 0 } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE status=$${params.length}`;
  }
  params.push(limit, offset);
  const result = await pool.query(
    `SELECT l.*, q.total_cents, q.status as quote_status, a.scheduled_date, a.scheduled_time, a.status as appt_status
     FROM leads l
     LEFT JOIN LATERAL (SELECT total_cents, status FROM quotes WHERE lead_id=l.id ORDER BY id DESC LIMIT 1) q ON TRUE
     LEFT JOIN LATERAL (SELECT scheduled_date, scheduled_time, status FROM appointments WHERE lead_id=l.id ORDER BY id DESC LIMIT 1) a ON TRUE
     ${where}
     ORDER BY l.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return result.rows;
}

async function countLeads() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='new') as new_count,
      COUNT(*) FILTER (WHERE status='qualified') as qualified_count,
      COUNT(*) FILTER (WHERE status='booked') as booked_count,
      COUNT(*) FILTER (WHERE status='disqualified') as disqualified_count,
      COUNT(*) as total
    FROM leads
    WHERE created_at > NOW() - INTERVAL '30 days'
  `);
  return result.rows[0];
}

module.exports = { createLead, updateLeadQualification, getLeadById, getLeads, countLeads };
