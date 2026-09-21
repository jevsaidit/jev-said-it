-- Everything is idempotent: re-running the migration changes nothing.

-- How far each indexer has read. Updated in the SAME transaction as the data,
-- so the cursor can never be ahead of the data it claims to have read.
CREATE TABLE IF NOT EXISTS cursors (
  name  TEXT PRIMARY KEY,
  block BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  token     TEXT    NOT NULL,
  block     BIGINT  NOT NULL,
  log_index INTEGER NOT NULL,
  tx_hash   TEXT    NOT NULL,
  from_addr TEXT    NOT NULL,
  to_addr   TEXT    NOT NULL,
  value     NUMERIC(78, 0) NOT NULL,
  PRIMARY KEY (token, block, log_index)
);
CREATE INDEX IF NOT EXISTS transfers_to   ON transfers (token, to_addr, block);
CREATE INDEX IF NOT EXISTS transfers_from ON transfers (token, from_addr, block);

-- The v4 pools whose Swaps are followed, and from which block.
CREATE TABLE IF NOT EXISTS pools (
  pool_id     TEXT PRIMARY KEY,
  token       TEXT   NOT NULL,
  start_block BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS swaps (
  pool_id        TEXT    NOT NULL,
  block          BIGINT  NOT NULL,
  log_index      INTEGER NOT NULL,
  tx_hash        TEXT    NOT NULL,
  sender         TEXT    NOT NULL,
  amount0        NUMERIC(78, 0) NOT NULL,
  amount1        NUMERIC(78, 0) NOT NULL,
  sqrt_price_x96 NUMERIC(78, 0) NOT NULL,
  liquidity      NUMERIC(78, 0) NOT NULL,
  tick           INTEGER NOT NULL,
  fee            INTEGER NOT NULL,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS swaps_pool ON swaps (pool_id, block, log_index);

-- One row per question. `json` is EXACTLY the text whose keccak256 is `id`: it is what gets
-- published, and it is never reformatted.
CREATE TABLE IF NOT EXISTS questions (
  id           TEXT PRIMARY KEY,
  epoch        INTEGER NOT NULL,
  deadline     BIGINT  NOT NULL,
  horizon      INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  token        TEXT    NOT NULL,
  pool_id      TEXT    NOT NULL,
  json         TEXT    NOT NULL,
  -- PENDING: written, tx not yet confirmed · OPEN: QuestionsOpened verified on-chain
  -- FAILED: tx failed or epoch changed before sending: it does not exist for anyone
  status       TEXT    NOT NULL,
  tx_hash      TEXT,
  opened_block BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questions_epoch ON questions (epoch, status);

-- Block 4: outcomes. outcome = '1' | '0' | 'VOID' | 'UNRESOLVABLE', NULL until it can be decided.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS outcome     TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS block0      BIGINT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS block1      BIGINT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS sqrt0       NUMERIC(78, 0);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS sqrt1       NUMERIC(78, 0);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Holders' calls, from the CallLedger's CallSubmitted events.
CREATE TABLE IF NOT EXISTS calls (
  epoch           INTEGER NOT NULL,
  caller          TEXT    NOT NULL,
  question_id     TEXT    NOT NULL,
  agree           BOOLEAN NOT NULL,
  balance_at_call NUMERIC(78, 0) NOT NULL,
  block           BIGINT  NOT NULL,
  log_index       INTEGER NOT NULL,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS calls_epoch ON calls (epoch, caller);

-- One row per closed epoch. `payload` is what gets published: scores, amounts, proofs.
CREATE TABLE IF NOT EXISTS epochs (
  epoch      INTEGER PRIMARY KEY,
  -- PAYABLE: root computed · PUBLISHED: EpochRootSet verified on-chain · NOT_PAYABLE: see reason
  state      TEXT NOT NULL,
  reason     TEXT,
  root       TEXT,
  budget     NUMERIC(78, 0),
  payload    TEXT NOT NULL,
  tx_hash    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The token's ticker, read with symbol() at opening. The site needs it, it is NOT in the committed
-- JSON: a symbol is chosen by whoever launches the token, and decides nothing.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS symbol TEXT;

-- Every treasury action, published at /treasury: collections from the Pons escrow and buybacks.
CREATE TABLE IF NOT EXISTS treasury_ops (
  id       SERIAL PRIMARY KEY,
  epoch    INTEGER,
  kind     TEXT NOT NULL, -- CLAIM | SWAP | SWAP_SKIPPED
  tx_hash  TEXT,
  detail   TEXT NOT NULL,
  at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS treasury_ops_epoch ON treasury_ops (epoch, kind);
