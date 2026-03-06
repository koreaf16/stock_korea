import { randomUUID } from "node:crypto";

import oracledb from "oracledb";

import { nowIso } from "../../utils.js";

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];

type Provider = "ORACLE" | "MEMORY";

interface OracleEnv {
  user: string;
  password: string;
  connectString: string;
}

export interface TelegramChannel {
  channelId: string;
  channelUsername: string;
  channelName: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTelegramChannelInput {
  channelUsername: string;
  channelName: string;
  isActive?: boolean;
}

export interface UpdateTelegramChannelInput {
  channelUsername?: string;
  channelName?: string;
  isActive?: boolean;
}

export interface TelegramChannelManager {
  provider: Provider;
  listChannels: () => Promise<TelegramChannel[]>;
  listActiveUsernames: () => Promise<string[]>;
  createChannel: (input: CreateTelegramChannelInput) => Promise<TelegramChannel>;
  updateChannel: (channelId: string, input: UpdateTelegramChannelInput) => Promise<TelegramChannel | null>;
  deleteChannel: (channelId: string) => Promise<boolean>;
}

interface OracleChannelRow {
  CHANNEL_ID: string;
  CHANNEL_USERNAME: string;
  CHANNEL_NAME: string;
  IS_ACTIVE: number;
  CREATED_AT: Date | string;
  UPDATED_AT: Date | string;
}

export function createTelegramChannelManager(): TelegramChannelManager {
  const oracleEnv = readOracleEnv();
  const memoryStore = new Map<string, TelegramChannel>();
  let provider: Provider = oracleEnv ? "ORACLE" : "MEMORY";
  let pool: oracledb.Pool | null = null;

  async function ensurePool(): Promise<oracledb.Pool | null> {
    if (!oracleEnv) {
      provider = "MEMORY";
      return null;
    }

    if (pool) {
      return pool;
    }

    try {
      pool = await oracledb.createPool({
        user: oracleEnv.user,
        password: oracleEnv.password,
        connectString: oracleEnv.connectString,
        poolMin: 0,
        poolMax: 4,
        poolIncrement: 1,
        queueTimeout: 3_000
      });
      provider = "ORACLE";
      return pool;
    } catch (error) {
      provider = "MEMORY";
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[zone0][telegram-manager] oracle pool init failed, fallback to memory: ${message}`);
      return null;
    }
  }

  async function withConnection<T>(handler: (connection: oracledb.Connection) => Promise<T>): Promise<T | null> {
    const activePool = await ensurePool();
    if (!activePool) {
      return null;
    }

    let connection: oracledb.Connection | null = null;
    try {
      connection = await activePool.getConnection();
    } catch (error) {
      provider = "MEMORY";
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[zone0][telegram-manager] oracle connection failed, fallback to memory: ${message}`);
      return null;
    }

    try {
      return await handler(connection);
    } finally {
      if (connection) {
        await connection.close();
      }
    }
  }

  async function listChannels(): Promise<TelegramChannel[]> {
    const oracleRows = await withConnection(async (connection) => {
      const result = await connection.execute<OracleChannelRow>(
        `
          select CHANNEL_ID, CHANNEL_USERNAME, CHANNEL_NAME, IS_ACTIVE, CREATED_AT, UPDATED_AT
          from TB_ZONE0_TG_CHANNELS
          order by UPDATED_AT desc, CHANNEL_ID desc
        `
      );
      const rows = (result.rows ?? []) as unknown as OracleChannelRow[];
      return rows.map(toTelegramChannel);
    });

    if (oracleRows) {
      return oracleRows;
    }

    return [...memoryStore.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function listActiveUsernames(): Promise<string[]> {
    const oracleRows = await withConnection(async (connection) => {
      const result = await connection.execute<{ CHANNEL_USERNAME: string }>(
        `
          select CHANNEL_USERNAME
          from TB_ZONE0_TG_CHANNELS
          where IS_ACTIVE = 1
          order by CHANNEL_USERNAME
        `
      );
      const rows = (result.rows ?? []) as Array<{ CHANNEL_USERNAME: string }>;
      return rows
        .map((row) => normalizeUsername(row.CHANNEL_USERNAME))
        .filter(Boolean);
    });

    if (oracleRows) {
      return oracleRows;
    }

    return [...memoryStore.values()]
      .filter((item) => item.isActive)
      .map((item) => normalizeUsername(item.channelUsername))
      .filter(Boolean);
  }

  async function createChannel(input: CreateTelegramChannelInput): Promise<TelegramChannel> {
    const channelId = randomUUID();
    const normalized = normalizeChannelInput(input);
    const now = nowIso();

    const created = await withConnection(async (connection) => {
      await connection.execute(
        `
          insert into TB_ZONE0_TG_CHANNELS
            (CHANNEL_ID, CHANNEL_USERNAME, CHANNEL_NAME, IS_ACTIVE, CREATED_AT, UPDATED_AT)
          values
            (:channelId, :channelUsername, :channelName, :isActive, systimestamp, systimestamp)
        `,
        {
          channelId,
          channelUsername: normalized.channelUsername,
          channelName: normalized.channelName,
          isActive: normalized.isActive ? 1 : 0
        },
        { autoCommit: true }
      );

      const selected = await connection.execute<OracleChannelRow>(
        `
          select CHANNEL_ID, CHANNEL_USERNAME, CHANNEL_NAME, IS_ACTIVE, CREATED_AT, UPDATED_AT
          from TB_ZONE0_TG_CHANNELS
          where CHANNEL_ID = :channelId
        `,
        { channelId }
      );

      const row = ((selected.rows ?? [])[0] as OracleChannelRow | undefined) ?? null;
      return row ? toTelegramChannel(row) : null;
    });

    if (created) {
      return created;
    }

    const item: TelegramChannel = {
      channelId,
      channelUsername: normalized.channelUsername,
      channelName: normalized.channelName,
      isActive: normalized.isActive,
      createdAt: now,
      updatedAt: now
    };
    memoryStore.set(channelId, item);
    return item;
  }

  async function updateChannel(channelId: string, input: UpdateTelegramChannelInput): Promise<TelegramChannel | null> {
    const normalizedId = channelId.trim();
    if (!normalizedId) {
      return null;
    }

    const fields = normalizeUpdateInput(input);

    const updated = await withConnection(async (connection) => {
      const sets: string[] = [];
      const binds: oracledb.BindParameters = {
        channelId: normalizedId
      };

      if (fields.channelUsername !== undefined) {
        sets.push("CHANNEL_USERNAME = :channelUsername");
        binds.channelUsername = fields.channelUsername;
      }
      if (fields.channelName !== undefined) {
        sets.push("CHANNEL_NAME = :channelName");
        binds.channelName = fields.channelName;
      }
      if (fields.isActive !== undefined) {
        sets.push("IS_ACTIVE = :isActive");
        binds.isActive = fields.isActive ? 1 : 0;
      }
      sets.push("UPDATED_AT = systimestamp");

      const result = await connection.execute(
        `
          update TB_ZONE0_TG_CHANNELS
          set ${sets.join(", ")}
          where CHANNEL_ID = :channelId
        `,
        binds,
        { autoCommit: true }
      );

      if ((result.rowsAffected ?? 0) <= 0) {
        return null;
      }

      const selected = await connection.execute<OracleChannelRow>(
        `
          select CHANNEL_ID, CHANNEL_USERNAME, CHANNEL_NAME, IS_ACTIVE, CREATED_AT, UPDATED_AT
          from TB_ZONE0_TG_CHANNELS
          where CHANNEL_ID = :channelId
        `,
        { channelId: normalizedId }
      );

      const row = ((selected.rows ?? [])[0] as OracleChannelRow | undefined) ?? null;
      return row ? toTelegramChannel(row) : null;
    });

    if (updated !== null) {
      return updated;
    }

    const current = memoryStore.get(normalizedId);
    if (!current) {
      return null;
    }

    const merged: TelegramChannel = {
      ...current,
      channelUsername: fields.channelUsername ?? current.channelUsername,
      channelName: fields.channelName ?? current.channelName,
      isActive: fields.isActive ?? current.isActive,
      updatedAt: nowIso()
    };
    memoryStore.set(normalizedId, merged);
    return merged;
  }

  async function deleteChannel(channelId: string): Promise<boolean> {
    const normalizedId = channelId.trim();
    if (!normalizedId) {
      return false;
    }

    const deleted = await withConnection(async (connection) => {
      const result = await connection.execute(
        `
          delete from TB_ZONE0_TG_CHANNELS
          where CHANNEL_ID = :channelId
        `,
        { channelId: normalizedId },
        { autoCommit: true }
      );
      return (result.rowsAffected ?? 0) > 0;
    });

    if (deleted !== null) {
      return deleted;
    }

    return memoryStore.delete(normalizedId);
  }

  return {
    get provider() {
      return provider;
    },
    listChannels,
    listActiveUsernames,
    createChannel,
    updateChannel,
    deleteChannel
  };
}

function readOracleEnv(): OracleEnv | null {
  const user = process.env.ORACLE_USER?.trim();
  const password = process.env.ORACLE_PASSWORD?.trim();
  const connectString = process.env.ORACLE_CONNECTION_STRING?.trim();

  if (!user || !password || !connectString) {
    return null;
  }

  return {
    user,
    password,
    connectString
  };
}

function normalizeUsername(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function normalizeChannelInput(input: CreateTelegramChannelInput): {
  channelUsername: string;
  channelName: string;
  isActive: boolean;
} {
  const channelUsername = normalizeUsername(input.channelUsername ?? "");
  if (!channelUsername) {
    throw new Error("channelUsername은 필수입니다.");
  }

  const channelName = String(input.channelName ?? "").trim();
  if (!channelName) {
    throw new Error("channelName은 필수입니다.");
  }

  return {
    channelUsername,
    channelName,
    isActive: input.isActive ?? true
  };
}

function normalizeUpdateInput(input: UpdateTelegramChannelInput): {
  channelUsername?: string;
  channelName?: string;
  isActive?: boolean;
} {
  const next: {
    channelUsername?: string;
    channelName?: string;
    isActive?: boolean;
  } = {};

  if (input.channelUsername !== undefined) {
    const normalized = normalizeUsername(input.channelUsername);
    if (!normalized) {
      throw new Error("channelUsername이 비어 있습니다.");
    }
    next.channelUsername = normalized;
  }

  if (input.channelName !== undefined) {
    const trimmed = input.channelName.trim();
    if (!trimmed) {
      throw new Error("channelName이 비어 있습니다.");
    }
    next.channelName = trimmed;
  }

  if (input.isActive !== undefined) {
    next.isActive = Boolean(input.isActive);
  }

  if (!next.channelUsername && !next.channelName && next.isActive === undefined) {
    throw new Error("수정할 필드가 없습니다.");
  }

  return next;
}

function toIso(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  return nowIso();
}

function toTelegramChannel(row: OracleChannelRow): TelegramChannel {
  return {
    channelId: row.CHANNEL_ID,
    channelUsername: normalizeUsername(row.CHANNEL_USERNAME),
    channelName: row.CHANNEL_NAME,
    isActive: Number(row.IS_ACTIVE) === 1,
    createdAt: toIso(row.CREATED_AT),
    updatedAt: toIso(row.UPDATED_AT)
  };
}
