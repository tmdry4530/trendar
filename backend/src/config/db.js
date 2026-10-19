import mysql from 'mysql2/promise';

export function buildPoolConfig(env = process.env) {
  const url = env.MYSQL_URL || env.DATABASE_URL;
  if (url) return { uri: url, timezone: 'Z' };
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
  };
}

export const pool = mysql.createPool(buildPoolConfig());

// Date 바인딩과 NOW() 범위를 서버·프로세스의 로컬 시간대와 무관하게 맞춘다.
pool.pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});
