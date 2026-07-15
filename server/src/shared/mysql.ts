import mysql from 'mysql2/promise';
import { config } from './config.js';
import { log } from './logger.js';

let pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      waitForConnections: true,
      connectionLimit: 16,
      maxIdle: 8,
      enableKeepAlive: true,
      namedPlaceholders: true,
    });
  }
  return pool;
}

export async function waitForMysql(): Promise<void> {
  for (let i = 0; i < 90; i++) {
    try {
      const c = await getPool().getConnection();
      await c.ping();
      c.release();
      return;
    } catch (err) {
      if (i % 10 === 0) log.info('waiting for mysql...', { err: String(err) });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('mysql not reachable');
}

/**
 * The durable core:
 *  - `events`  : the domain row (source of truth for the feed store)
 *  - `outbox`  : transactional outbox — written in the SAME tx as the domain row,
 *                so publish-to-log can never diverge from the committed state.
 *  - `clubs` / `memberships` / `preferences`: reference data.
 */
export async function ensureSchema(): Promise<void> {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS clubs (
      id           VARCHAR(64)  NOT NULL PRIMARY KEY,
      name         VARCHAR(255) NOT NULL,
      member_count INT          NOT NULL DEFAULT 0,
      created_at   BIGINT       NOT NULL
    )`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS memberships (
      club_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      PRIMARY KEY (club_id, user_id),
      KEY idx_user (user_id)
    )`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS events (
      id           VARCHAR(32)  NOT NULL PRIMARY KEY,   -- ULID
      club_id      VARCHAR(64)  NOT NULL,
      type         VARCHAR(32)  NOT NULL,
      actor_id     VARCHAR(64)  NOT NULL,
      actor_name   VARCHAR(255) NOT NULL,
      club_name    VARCHAR(255) NOT NULL,
      text         TEXT         NOT NULL,
      member_count INT          NOT NULL,
      created_at   BIGINT       NOT NULL,
      KEY idx_club (club_id, id)
    )`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS outbox (
      seq          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
      event_id     VARCHAR(32)  NOT NULL,
      club_id      VARCHAR(64)  NOT NULL,
      payload      JSON         NOT NULL,
      published    TINYINT      NOT NULL DEFAULT 0,
      created_at   BIGINT       NOT NULL,
      KEY idx_unpublished (published, seq)
    )`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS preferences (
      user_id     VARCHAR(64) NOT NULL PRIMARY KEY,
      in_app      TINYINT     NOT NULL DEFAULT 1,
      email       TINYINT     NOT NULL DEFAULT 1,
      push        TINYINT     NOT NULL DEFAULT 0,
      muted_clubs JSON        NOT NULL
    )`);

  log.info('mysql schema ready');
}
