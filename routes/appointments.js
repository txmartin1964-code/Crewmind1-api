/**
 * routes/appointments.js
 * Owns: HTTP handling for appointment booking and confirmation lookups.
 * Does NOT own: DB writes (db/appointments.js), email sending (services/email.js).
 */

const express = require('express');
const router = express.Router();

const { getAvailableSlots, bookSlot, getAppointmentByCode, markConfirmationSent } = require('../db/appointments');
const { getLeadById } = require('../db/leads');
const { getQuoteByLeadId } = require('../db/quotes');
const { sendAppointmentConfirmation } = require('../services/email');

/**
 * GET /api/appointments/slots?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns available calendar slots in the given date range.
 */
router.get('/slots', async (req, res) => {
  try {
    const from = req.query.from || new Date().toISOString().slice(0, 10);
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + 30);
    const to = req.query.to || toDate.toISOString().slice(0, 10);

    const slots = await getAvailableSlots(from, to);
    res.json({ slots });
  } catch (err) {
    console.error('[appointments] slots error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/appointments/book
 * Books a time slot for a lead. Sends confirmation email.
 */
router.post('/book', async (req, res) => {
  try {
    const { lead_id, quote_id, slot_date, slot_time } = req.body;

    if (!lead_id || !slot_date || !slot_time) {
      return res.status(400).json({ error: 'lead_id, slot_date, and slot_time are required.' });
    }

    const lead = await getLeadById(lead_id);
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });

    // Prevent double-booking the same lead
    if (lead.status === 'booked') {
      return res.status(409).json({ error: 'This lead already has an appointment booked.' });
    }

    const appt = await bookSlot(slot_date, slot_time, lead_id, quote_id || null);

    // Send confirmation email
    try {
      await sendAppointmentConfirmation(appt, lead);
      await markConfirmationSent(appt.id);
    } catch (emailErr) {
      console.error('[appointments] confirmation email failed:', emailErr.message);
      // Non-fatal
    }

    res.json({
      success: true,
      confirmation_code: appt.confirmation_code,
      scheduled_date: appt.scheduled_date,
      scheduled_time: appt.scheduled_time,
    });
  } catch (err) {
    if (err.message === 'Slot no longer available') {
      return res.status(409).json({ error: 'That time slot is no longer available. Please choose another.' });
    }
    console.error('[appointments] book error:', err);
    res.status(500).json({ error: 'Booking failed. Please try again.' });
  }
});

/**
 * GET /api/appointments/confirm/:code
 * Look up appointment details by confirmation code.
 */
router.get('/confirm/:code', async (req, res) => {
  try {
    const appt = await getAppointmentByCode(req.params.code.toUpperCase());
    if (!appt) return res.status(404).json({ error: 'Appointment not found.' });
    res.json({ appointment: appt });
  } catch (err) {
    console.error('[appointments] confirm error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
