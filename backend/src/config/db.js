import mysql from 'mysql2/promise';

const url = process.env.MYSQL_URL || process.env.DATABASE_URL;

export const pool = url
  ? mysql.createPool(url)
  : mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
    });
