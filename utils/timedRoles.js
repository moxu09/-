const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const TABLE = 'bot_timed_role_grants';
const POLL_MS = 15_000;
const MAX_DURATION_MS = 8760 * 3_600_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function parseDuration(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase();
  if (!text || text.length > 32) return null;
  const units = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
  const seen = new Set();
  const token = /\s*(\d+)\s*([dhms])/gy;
  const label = [];
  let position = 0;
  let ms = 0;
  while (position < text.length) {
    token.lastIndex = position;
    const match = token.exec(text);
    if (!match || seen.has(match[2])) return null;
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount)) return null;
    ms += amount * units[match[2]];
    if (!Number.isSafeInteger(ms) || ms > MAX_DURATION_MS) return null;
    seen.add(match[2]);
    label.push(`${amount}${match[2]}`);
    position = token.lastIndex;
  }
  return ms > 0 ? { ms, label: label.join('') } : null;
}

function buildTimedRoleCommand() {
  return new SlashCommandBuilder()
    .setName('限時身分組')
    .setDescription('指定老闆與選填陪陪的限時身分組，到期自動移除')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addRoleOption(o => o.setName('身分組').setDescription('到期後要移除的身分組').setRequired(true))
    .addUserOption(o => o.setName('老闆').setDescription('必填，領取限時身分組的老闆').setRequired(true))
    .addStringOption(o => o.setName('時長').setDescription('輸入 d（天）、h（小時）、m（分鐘）、s（秒），例如 2d、1d12h、30s').setMaxLength(32).setRequired(true))
    .addUserOption(o => o.setName('陪陪').setDescription('選填，一起領取限時身分組的陪陪'));
}

function buildExtendTimedRoleCommand() {
  return new SlashCommandBuilder()
    .setName('延長限時身分組')
    .setDescription('延長已發放且尚未到期的限時身分組')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addRoleOption(o => o.setName('身分組').setDescription('要延長的身分組').setRequired(true))
    .addUserOption(o => o.setName('延長的人').setDescription('要延長期限的成員').setRequired(true))
    .addStringOption(o => o.setName('延長多久').setDescription('輸入 d（天）、h（小時）、m（分鐘）、s（秒），例如 2d、1d12h、30s').setMaxLength(32).setRequired(true));
}

function assertDb(result, action) {
  if (result.error) throw new Error(`${action}失敗：${result.error.message}`);
  return result.data;
}

function createTimedRoleManager({ db, client, guildId, logger = console, now = () => new Date() }) {
  if (!db || !client || !guildId) throw new Error('限時身分組缺少資料庫、機器人或伺服器 ID');
  let timer;
  let busy = false;
  const retryAfter = new Map();
  const expiryTimers = new Map();
  const retryKey = row => `${row.guild_id}:${row.user_id}:${row.role_id}`;

  function scheduleExpiry(row) {
    const key = retryKey(row);
    if (expiryTimers.has(key)) clearTimeout(expiryTimers.get(key));
    expiryTimers.delete(key);
    const delay = new Date(row.expires_at).getTime() - now().getTime();
    if (delay <= 0 || delay + 50 > MAX_TIMEOUT_MS) return;
    const timeout = setTimeout(() => {
      expiryTimers.delete(key);
      void sweep();
    }, Math.max(1, delay + 50));
    timeout.unref?.();
    expiryTimers.set(key, timeout);
  }

  async function recordError(row, error) {
    retryAfter.set(retryKey(row), now().getTime() + 5 * 60_000);
    await db.from(TABLE).update({ last_error: String(error?.message || error).slice(0, 500) })
      .eq('guild_id', row.guild_id).eq('user_id', row.user_id).eq('role_id', row.role_id)
      .eq('expires_at', row.expires_at).is('removed_at', null);
  }

  async function markApplied(row) {
    const result = await db.from(TABLE).update({ applied_at: now().toISOString(), last_error: null })
      .eq('guild_id', row.guild_id).eq('user_id', row.user_id).eq('role_id', row.role_id)
      .eq('expires_at', row.expires_at).is('removed_at', null);
    assertDb(result, '記錄身分組發放');
    retryAfter.delete(retryKey(row));
  }

  async function getGuild() {
    return client.guilds.cache.get(guildId) || client.guilds.fetch(guildId);
  }

  async function apply(row, guild) {
    const member = await guild.members.fetch(row.user_id);
    if (!member.roles.cache.has(row.role_id)) await member.roles.add(row.role_id, '限時身分組');
    await markApplied(row);
    const latest = assertDb(await db.from(TABLE).select('expires_at,removed_at')
      .eq('guild_id', row.guild_id).eq('user_id', row.user_id).eq('role_id', row.role_id)
      .maybeSingle(), '確認發放後的到期時間');
    if (!latest || latest.removed_at) {
      try {
        await member.roles.remove(row.role_id, '限時身分組已到期');
      } catch (error) {
        if (latest?.removed_at) {
          assertDb(await db.from(TABLE).update({ removed_at: null, last_error: String(error?.message || error).slice(0, 500) })
            .eq('guild_id', row.guild_id).eq('user_id', row.user_id).eq('role_id', row.role_id)
            .eq('expires_at', latest.expires_at).eq('removed_at', latest.removed_at), '保留待重試的到期身分組');
        }
        throw error;
      }
      const renewed = assertDb(await db.from(TABLE).select('*')
        .eq('guild_id', row.guild_id).eq('user_id', row.user_id).eq('role_id', row.role_id)
        .is('removed_at', null).gt('expires_at', now().toISOString()).maybeSingle(), '確認新發放的身分組');
      if (renewed) await apply(renewed, guild);
    } else if (new Date(latest.expires_at) <= now()) {
      await expire({ ...row, expires_at: latest.expires_at }, guild);
    }
  }

  async function expire(row, guild) {
    // Re-read immediately before the Discord call so a renewed grant is not removed by an old sweep.
    const current = assertDb(await db.from(TABLE).select('expires_at,removed_at')
      .eq('guild_id', row.guild_id).eq('user_id', row.user_id).eq('role_id', row.role_id).maybeSingle(), '確認到期時間');
    if (!current || current.removed_at || current.expires_at !== row.expires_at || new Date(current.expires_at) > now()) return;
    let member;
    try {
      member = await guild.members.fetch(row.user_id);
    } catch (error) {
      if (error?.code !== 10007) throw error; // Unknown Member: nothing remains to remove.
    }
    if (member?.roles.cache.has(row.role_id)) {
      await member.roles.remove(row.role_id, '限時身分組到期');
    }
    const updated = assertDb(await db.from(TABLE).update({ removed_at: now().toISOString(), last_error: null })
      .eq('guild_id', row.guild_id).eq('user_id', row.user_id).eq('role_id', row.role_id)
      .eq('expires_at', row.expires_at).is('removed_at', null).select('guild_id'), '記錄身分組到期');
    if (!updated?.length && member) {
      // A new grant was written while Discord removed the old one: force re-application.
      const renewed = assertDb(await db.from(TABLE).update({ applied_at: null })
        .eq('guild_id', row.guild_id).eq('user_id', row.user_id).eq('role_id', row.role_id)
        .is('removed_at', null).select('*'), '恢復已延長的身分組');
      if (renewed?.length) await apply(renewed[0], guild);
    }
    retryAfter.delete(retryKey(row));
  }

  async function sweep() {
    if (busy) return;
    busy = true;
    try {
      const guild = await getGuild();
      const due = assertDb(await db.from(TABLE).select('*').eq('guild_id', guildId)
        .is('removed_at', null).lte('expires_at', now().toISOString()).order('expires_at').limit(100), '讀取到期限時身分組');
      for (const row of due || []) {
        if ((retryAfter.get(retryKey(row)) || 0) > now().getTime()) continue;
        try { await expire(row, guild); }
        catch (error) { logger.error('[限時身分組] 移除失敗', { userId: row.user_id, roleId: row.role_id, error: error?.message }); await recordError(row, error); }
      }
      const pending = assertDb(await db.from(TABLE).select('*').eq('guild_id', guildId)
        .is('removed_at', null).is('applied_at', null).gt('expires_at', now().toISOString()).order('expires_at').limit(100), '讀取待補發限時身分組');
      for (const row of pending || []) {
        if ((retryAfter.get(retryKey(row)) || 0) > now().getTime()) continue;
        try { await apply(row, guild); }
        catch (error) { logger.error('[限時身分組] 發放失敗', { userId: row.user_id, roleId: row.role_id, error: error?.message }); await recordError(row, error); }
      }
    } catch (error) {
      logger.error('[限時身分組] 排程失敗', error?.message || error);
    } finally { busy = false; }
  }

  function start() {
    if (timer) return;
    void sweep();
    timer = setInterval(() => { void sweep(); }, POLL_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const timeout of expiryTimers.values()) clearTimeout(timeout);
    expiryTimers.clear();
  }

  async function handle(interaction) {
    if (!interaction.isChatInputCommand?.() || !interaction.id) return interaction.editReply('❌ 請使用 Discord 的 /限時身分組 指令。');
    if (interaction.guildId !== guildId) return interaction.editReply('❌ 請在店家伺服器使用這個指令。');
    const allowed = interaction.guild.ownerId === interaction.user.id ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!allowed) return interaction.editReply('❌ 只有具備管理身分組權限的主管可以使用。');
    const role = interaction.options.getRole('身分組', true);
    const duration = parseDuration(interaction.options.getString('時長', true));
    const boss = interaction.options.getUser('老闆', true);
    const player = interaction.options.getUser('陪陪');
    if (!duration) return interaction.editReply('❌ 時長格式錯誤。可用 d、h、m、s，例如 2d 或 1d12h。最多 365 天。');
    if (role.id === guildId || role.managed) return interaction.editReply('❌ 不能使用 @everyone 或系統管理的身分組。');
    const botMember = await interaction.guild.members.fetchMe();
    if (role.position >= botMember.roles.highest.position) return interaction.editReply('❌ 請把機器人的身分組移到選定身分組的上方。');
    const actor = await interaction.guild.members.fetch(interaction.user.id);
    if (interaction.guild.ownerId !== interaction.user.id && role.position >= actor.roles.highest.position) {
      return interaction.editReply('❌ 你不能指定與自己最高身分組同級或更高的身分組。');
    }
    const people = [...new Map([boss, player].filter(Boolean).map(user => [user.id, user])).values()];
    const members = [];
    for (const person of people) {
      if (person.bot) return interaction.editReply('❌ 不能將限時身分組發給機器人。');
      try { members.push(await interaction.guild.members.fetch(person.id)); }
      catch { return interaction.editReply(`❌ <@${person.id}> 不在這家店的伺服器。`); }
    }
    const expiresAt = new Date(now().getTime() + duration.ms).toISOString();
    const failed = [];
    for (const member of members) {
      const row = { guild_id: guildId, user_id: member.id, role_id: role.id, expires_at: expiresAt,
        created_by: interaction.user.id, source_interaction_id: interaction.id,
        applied_at: null, removed_at: null, last_error: null };
      const saved = await db.from(TABLE).upsert(row, { onConflict: 'guild_id,user_id,role_id' }).select('*').single();
      if (saved.error) { failed.push(`<@${member.id}>（排程未儲存）`); logger.error('[限時身分組] 儲存失敗', saved.error.message); continue; }
      scheduleExpiry(saved.data);
      try { await apply(saved.data, interaction.guild); }
      catch (error) { failed.push(`<@${member.id}>（發放待重試）`); await recordError(saved.data, error); }
    }
    const successful = members.filter(member => !failed.some(item => item.includes(`<@${member.id}>`)));
    return interaction.editReply([
      successful.length ? `✅ 已將 <@&${role.id}> 發給 ${successful.map(member => `<@${member.id}>`).join('、')}，到期時間：<t:${Math.floor(new Date(expiresAt).getTime()/1000)}:F>。` : '',
      failed.length ? `⚠️ ${failed.join('、')}。請查看機器人權限；已儲存的發放會自動重試。` : '',
      '到期只會移除這次選定的身分組，其他身分組不會變動。',
    ].filter(Boolean).join('\n'));
  }

  async function extend(interaction) {
    if (!interaction.isChatInputCommand?.() || !interaction.id) return interaction.editReply('❌ 請使用 Discord 的 /延長限時身分組 指令。');
    if (interaction.guildId !== guildId) return interaction.editReply('❌ 請在店家伺服器使用這個指令。');
    const allowed = interaction.guild.ownerId === interaction.user.id ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!allowed) return interaction.editReply('❌ 只有具備管理身分組權限的主管可以使用。');
    const role = interaction.options.getRole('身分組', true);
    const person = interaction.options.getUser('延長的人', true);
    const duration = parseDuration(interaction.options.getString('延長多久', true));
    if (!duration) return interaction.editReply('❌ 延長時長格式錯誤。可用 d、h、m、s，例如 2d 或 1d12h。每次最多延長 365 天。');
    if (role.id === guildId || role.managed) return interaction.editReply('❌ 不能使用 @everyone 或系統管理的身分組。');
    const botMember = await interaction.guild.members.fetchMe();
    if (role.position >= botMember.roles.highest.position) return interaction.editReply('❌ 請把機器人的身分組移到選定身分組的上方。');
    const actor = await interaction.guild.members.fetch(interaction.user.id);
    if (interaction.guild.ownerId !== interaction.user.id && role.position >= actor.roles.highest.position) {
      return interaction.editReply('❌ 你不能指定與自己最高身分組同級或更高的身分組。');
    }
    if (person.bot) return interaction.editReply('❌ 不能延長機器人的身分組。');
    try { await interaction.guild.members.fetch(person.id); }
    catch { return interaction.editReply(`❌ <@${person.id}> 不在這家店的伺服器。`); }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = assertDb(await db.from(TABLE).select('*')
        .eq('guild_id', guildId).eq('user_id', person.id).eq('role_id', role.id).maybeSingle(), '讀取限時身分組');
      if (!current || current.removed_at || new Date(current.expires_at) <= now()) {
        return interaction.editReply('❌ 這位成員沒有尚未到期的限時身分組紀錄；請改用 /限時身分組。');
      }
      const expiresAt = new Date(new Date(current.expires_at).getTime() + duration.ms).toISOString();
      const updated = assertDb(await db.from(TABLE).update({ expires_at: expiresAt, applied_at: null, last_error: null })
        .eq('guild_id', guildId).eq('user_id', person.id).eq('role_id', role.id)
        .eq('expires_at', current.expires_at).is('removed_at', null)
        .gt('expires_at', now().toISOString()).select('*'), '延長限時身分組');
      if (!updated?.length) continue; // Another extension or expiry won the race; retry from the current record.
      scheduleExpiry(updated[0]);
      try {
        await apply(updated[0], interaction.guild);
        return interaction.editReply(`✅ 已將 <@${person.id}> 的 <@&${role.id}> 延長 ${duration.label}。\n原到期：<t:${Math.floor(new Date(current.expires_at).getTime() / 1000)}:F>\n新到期：<t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:F>`);
      } catch (error) {
        await recordError(updated[0], error);
        return interaction.editReply(`⚠️ 已延長 <@${person.id}> 的 <@&${role.id}> 至 <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:F>；身分組發放待機器人重試。`);
      }
    }
    return interaction.editReply('❌ 同一筆身分組正在被更新，請再試一次。');
  }

  return { handle, extend, sweep, start, stop };
}

module.exports = { buildTimedRoleCommand, buildExtendTimedRoleCommand, createTimedRoleManager, parseDuration };
