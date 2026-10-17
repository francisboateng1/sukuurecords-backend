const mysql = require('mysql2/promise');
require('dotenv').config();

const useDatabaseSSL = process.env.DB_SSL === 'true';

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 3306,

    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 15000
};

if (useDatabaseSSL) {
    dbConfig.ssl = {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
    };
}

const db = mysql.createPool(dbConfig);

module.exports = db;