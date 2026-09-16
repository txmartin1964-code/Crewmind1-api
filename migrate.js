module.exports = {
  up: async (client) => {
    // 1. Creates the estimates table
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

    // 2. Creates the leads table
    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(50),
        status VARCHAR(50) DEFAULT 'new',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
  },
  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS estimates;`);
    await client.query(`DROP TABLE IF EXISTS leads;`);
  }
};
