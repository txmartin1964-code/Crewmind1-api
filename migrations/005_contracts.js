/**
 * migrations/005_contracts.js
 *
 * Customer contracts generated from quotes, signable online.
 * - contract_number is human readable (CM-YYYY-NNNN) from a sequence.
 * - access_token is an unguessable random token: the public signing page
 *   is reached via /contract.html?c=<token>, never by serial id alone.
 * - Signing snapshots (signed_name, signed_at, signer_ip,
 *   signer_user_agent, signature_text, document_sha256) are written once
 *   at signing and the contract locks afterwards.
 */

module.exports = {
  name: '005_contracts',

  up: async (client) => {
    await client.query(`CREATE SEQUENCE IF NOT EXISTS contracts_number_seq START WITH 1;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS contracts (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER,
        quote_id INTEGER,
        contract_number VARCHAR(30) UNIQUE,
        access_token VARCHAR(64) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'draft',
        title VARCHAR(255),
        scope_of_work TEXT,
        total_cents INTEGER DEFAULT 0,
        deposit_cents INTEGER DEFAULT 0,
        terms TEXT,
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        job_address TEXT,
        signed_name VARCHAR(255),
        signed_at TIMESTAMPTZ,
        signer_ip VARCHAR(45),
        signer_user_agent TEXT,
        signature_text VARCHAR(255),
        document_sha256 VARCHAR(64),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS contracts_quote_idx ON contracts (quote_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS contracts_lead_idx ON contracts (lead_id);`);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS contracts;`);
    await client.query(`DROP SEQUENCE IF EXISTS contracts_number_seq;`);
  }
};
