require('dotenv').config();

const db = require('./db');

async function testConnection() {
    try {
        const [rows] = await db.query(`
            SELECT
                VERSION() AS database_version,
                DATABASE() AS current_database
        `);

        console.log('Database connection successful.');
        console.log(rows[0]);
    } catch (error) {
        console.error('Database connection failed.');
        console.error('Error code:', error.code);
        console.error('Error message:', error.message);

        process.exitCode = 1;
    } finally {
        await db.end();
    }
}

testConnection();