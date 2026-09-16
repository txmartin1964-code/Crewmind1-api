module.exports = {
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS estimates (
        id SERIAL PRIMARY KEY,
        lead_id INT,
        amount NUMERIC(10, 2),
        status VARCHAR(50) DEFAULT 'pending',
        details TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
  },
  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS estimates;`);
  }
};
