const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createEmploymentMemberHandler,
  getEmploymentReportChannelGender,
  provisionSignedEmploymentReportChannels,
} = require("../utils/employmentReportChannels");

const BUSINESS_GUILD_ID = "1501098191813214312";
const STAFF_GUILD_ID = "1501836172199202856";

function createSupabaseMock({
  signings = [],
  staffRecords = [],
  insertError = null,
} = {}) {
  const rows = {
    employment_contract_signings: signings.map((row) => ({ ...row })),
    players: staffRecords.map((row) => ({ ...row })),
  };
  const operations = [];
  const updates = [];
  const inserts = [];

  function from(table) {
    let operation = "select";
    let payload = null;
    const filters = [];
    let maximum = null;

    function filteredRows() {
      let result = [...(rows[table] || [])];
      for (const filter of filters) {
        if (filter.type === "eq") {
          result = result.filter(
            (row) => String(row[filter.column]) === String(filter.value),
          );
        } else if (filter.type === "in") {
          result = result.filter((row) =>
            filter.values.map(String).includes(String(row[filter.column])),
          );
        }
      }
      if (maximum !== null) result = result.slice(0, maximum);
      return result;
    }

    function execute(singleMode = null) {
      if (operation === "insert") {
        operations.push({ type: "insert", table, payload });
        inserts.push({ table, payload });
        if (insertError) return { data: null, error: insertError };
        const row = { id: `new-${table}-${rows[table].length + 1}`, ...payload };
        rows[table].push(row);
        return { data: singleMode ? row : [row], error: null };
      }
      if (operation === "update") {
        const matches = filteredRows();
        operations.push({ type: "update", table, payload, filters });
        updates.push({ table, payload, filters });
        for (const row of matches) Object.assign(row, payload);
        const data = singleMode
          ? matches[0] || null
          : matches.map((row) => ({ id: row.id }));
        return { data, error: null };
      }
      const data = filteredRows();
      if (singleMode) return { data: data[0] || null, error: null };
      return { data, error: null };
    }

    const query = {
      select() {
        return query;
      },
      eq(column, value) {
        filters.push({ type: "eq", column, value });
        return query;
      },
      in(column, values) {
        filters.push({ type: "in", column, values });
        return query;
      },
      order(column, options = {}) {
        rows[table].sort((left, right) => {
          const result = String(left[column] || "").localeCompare(
            String(right[column] || ""),
          );
          return options.ascending === false ? -result : result;
        });
        return query;
      },
      limit(value) {
        maximum = value;
        return Promise.resolve(execute());
      },
      update(value) {
        operation = "update";
        payload = value;
        return query;
      },
      insert(value) {
        operation = "insert";
        payload = value;
        return query;
      },
      single() {
        return Promise.resolve(execute("single"));
      },
      maybeSingle() {
        return Promise.resolve(execute("single"));
      },
      then(resolve, reject) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };
    return query;
  }

  return { from, rows, operations, updates, inserts };
}

function createMember(id, guildId, roleNames = []) {
  return {
    id,
    guild: { id: guildId },
    roles: {
      cache: {
        map(callback) {
          return roleNames.map((name) => callback({ name }));
        },
      },
    },
  };
}

test("簽署性別只把男與女映射至填單區分類", () => {
  assert.equal(getEmploymentReportChannelGender({ gender: "男" }), "男");
  assert.equal(getEmploymentReportChannelGender({ gender: "女陪" }), "女");
  assert.equal(getEmploymentReportChannelGender({ gender: "不透露" }), null);
});

test("兩位新人加入深夜員工群時都立即處理且不使用延遲", async () => {
  const calls = [];
  const releases = [];
  const handler = createEmploymentMemberHandler({
    staffGuildId: STAFF_GUILD_ID,
    provision(args) {
      calls.push(args);
      return new Promise((resolve) => releases.push(resolve));
    },
  });

  const first = handler(
    createMember("111111111111111111", STAFF_GUILD_ID, ["深夜男陪陪"]),
  );
  const second = handler(
    createMember("222222222222222222", STAFF_GUILD_ID, ["女陪"]),
  );
  const ignored = await handler(
    createMember("333333333333333333", BUSINESS_GUILD_ID, ["女陪"]),
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    discordId: "111111111111111111",
    genderOverride: "男",
    reuseSignedAcrossOrganizations: true,
  });
  assert.equal(calls[1].genderOverride, "女");
  assert.equal(ignored, null);
  releases.forEach((resolve) => resolve({ provisioned: 1 }));
  await Promise.all([first, second]);

  const indexSource = fs.readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  const handlerStart = indexSource.indexOf(
    "function handleSignedEmploymentMemberEvent(member)",
  );
  const handlerEnd = indexSource.indexOf(
    "async function reconcileExistingSignedEmploymentMembers()",
    handlerStart,
  );
  const handlerSource = indexSource.slice(handlerStart, handlerEnd);
  assert.match(handlerSource, /client\.on\(Events\.GuildMemberAdd/);
  assert.doesNotMatch(handlerSource, /setTimeout\s*\(/);
});

test("同一新人連續五個事件只建立一次填單區", async () => {
  const calls = [];
  let release;
  const handler = createEmploymentMemberHandler({
    staffGuildId: STAFF_GUILD_ID,
    provision(args) {
      calls.push(args);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const member = createMember(
    "555555555555555555",
    STAFF_GUILD_ID,
    ["深夜女陪陪"],
  );

  const tasks = Array.from({ length: 5 }, () => handler(member));
  assert.equal(calls.length, 1);
  assert.ok(tasks.every((task) => task === tasks[0]));

  release({ provisioned: 1 });
  await Promise.all(tasks);
  assert.equal(calls.length, 1);
});

test("首次入群尚無性別時只為後續性別更新補跑一次", async () => {
  const calls = [];
  const releases = [];
  const handler = createEmploymentMemberHandler({
    staffGuildId: STAFF_GUILD_ID,
    provision(args) {
      calls.push(args);
      return new Promise((resolve) => releases.push(resolve));
    },
  });

  const first = handler(createMember("666666666666666666", STAFF_GUILD_ID));
  const updates = Array.from({ length: 4 }, () =>
    handler(
      createMember("666666666666666666", STAFF_GUILD_ID, ["深夜男陪陪"]),
    ),
  );
  assert.equal(calls.length, 1);
  releases.shift()({ provisioned: 0, manualRequired: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].genderOverride, "男");
  releases.shift()({ provisioned: 1 });
  await Promise.all([first, ...updates]);
  assert.equal(calls.length, 2);
});

test("漏建 EIP 的深夜新人會先新增 players 再標記簽署完成", async () => {
  const supabase = createSupabaseMock({
    signings: [
      {
        id: "deepnight-signing",
        organization_code: "deepnight",
        discord_id: "444444444444444444",
        discord_name: "深夜新人",
        status: "signed",
        signed_at: "2026-09-13T00:00:00.000Z",
        form_data: {
          real_name: "測試員工",
          gender: "女",
          birthday: "2000-01-01",
          bank_name: "測試銀行",
          bank_account: "1234567890",
        },
      },
    ],
  });

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    businessGuildId: BUSINESS_GUILD_ID,
    ensureStaffReportChannel: async () => ({ id: "555555555555555555" }),
  });

  assert.deepEqual(summary, {
    checked: 1,
    provisioned: 1,
    manualRequired: 0,
    failed: 0,
    crossStoreReused: 0,
  });
  assert.equal(supabase.inserts[0].table, "players");
  assert.equal(supabase.inserts[0].payload.guild_id, BUSINESS_GUILD_ID);
  assert.equal(
    supabase.inserts[0].payload.report_channel_id,
    "555555555555555555",
  );
  const insertIndex = supabase.operations.findIndex(
    (operation) => operation.type === "insert" && operation.table === "players",
  );
  const signingUpdateIndex = supabase.operations.findIndex(
    (operation) =>
      operation.type === "update" &&
      operation.table === "employment_contract_signings",
  );
  assert.ok(insertIndex >= 0 && signingUpdateIndex > insertIndex);
});

test("players 新增失敗時不會把簽署誤標成已完成", async () => {
  const supabase = createSupabaseMock({
    signings: [
      {
        id: "failed-signing",
        organization_code: "deepnight",
        discord_id: "666666666666666666",
        discord_name: "新增失敗新人",
        status: "signed",
        signed_at: "2026-09-13T00:00:00.000Z",
        form_data: { gender: "男" },
      },
    ],
    insertError: { code: "XX000", message: "insert failed" },
  });

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    businessGuildId: BUSINESS_GUILD_ID,
    ensureStaffReportChannel: async () => ({ id: "777777777777777777" }),
  });

  assert.deepEqual(summary, {
    checked: 1,
    provisioned: 0,
    manualRequired: 0,
    failed: 1,
    crossStoreReused: 0,
  });
  assert.equal(
    supabase.updates.some(
      (update) =>
        update.table === "employment_contract_signings" &&
        update.payload.form_data?.report_channel_status === "provisioned",
    ),
    false,
  );
});

test("入群時可沿用另一店最新簽署且不讀寫原店填單區欄位", async () => {
  const supabase = createSupabaseMock({
    signings: [
      {
        id: "qiunai-signing",
        organization_code: "qiunai",
        discord_id: "888888888888888888",
        discord_name: "跨店新人",
        status: "activated",
        signed_at: "2026-09-13T00:00:00.000Z",
        form_data: {
          gender: "女",
          report_channel_id: "999999999999999999",
          report_channel_status: "provisioned",
        },
      },
    ],
  });
  let staffForChannel = null;

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    organization: "deepnight",
    businessGuildId: BUSINESS_GUILD_ID,
    discordId: "888888888888888888",
    reuseSignedAcrossOrganizations: true,
    ensureStaffReportChannel: async (staff) => {
      staffForChannel = staff;
      return { id: "121212121212121212" };
    },
  });

  assert.deepEqual(summary, {
    checked: 1,
    provisioned: 1,
    manualRequired: 0,
    failed: 0,
    crossStoreReused: 1,
  });
  assert.equal(staffForChannel.report_channel_id, null);
  assert.equal(staffForChannel.salary_channel_id, null);
  assert.equal(supabase.inserts[0].payload.guild_id, BUSINESS_GUILD_ID);
  assert.equal(
    supabase.inserts[0].payload.report_channel_id,
    "121212121212121212",
  );
  assert.equal(
    supabase.updates.some(
      (update) => update.table === "employment_contract_signings",
    ),
    false,
  );
  assert.equal(
    supabase.rows.employment_contract_signings[0].form_data.report_channel_id,
    "999999999999999999",
  );
});

test("同時有兩店有效簽署時優先使用深夜資料", async () => {
  const supabase = createSupabaseMock({
    signings: [
      {
        id: "newer-qiunai-signing",
        organization_code: "qiunai",
        discord_id: "898989898989898989",
        discord_name: "跨店員工",
        status: "activated",
        signed_at: "2026-09-13T02:00:00.000Z",
        form_data: {
          gender: "女",
          report_channel_id: "909090909090909090",
          report_channel_status: "provisioned",
        },
      },
      {
        id: "older-deepnight-signing",
        organization_code: "deepnight",
        discord_id: "898989898989898989",
        discord_name: "深夜員工",
        status: "signed",
        signed_at: "2026-09-13T01:00:00.000Z",
        form_data: { gender: "男" },
      },
    ],
  });
  let staffForChannel = null;

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    organization: "deepnight",
    businessGuildId: BUSINESS_GUILD_ID,
    discordId: "898989898989898989",
    reuseSignedAcrossOrganizations: true,
    ensureStaffReportChannel: async (staff) => {
      staffForChannel = staff;
      return { id: "919191919191919191" };
    },
  });

  assert.equal(summary.provisioned, 1);
  assert.equal(summary.crossStoreReused, 0);
  assert.equal(staffForChannel.discord_name, "深夜員工");
  assert.equal(staffForChannel.gender, "男");
  const signingUpdates = supabase.updates.filter(
    (update) => update.table === "employment_contract_signings",
  );
  assert.equal(signingUpdates.length, 1);
  assert.deepEqual(signingUpdates[0].filters, [
    { type: "eq", column: "id", value: "older-deepnight-signing" },
  ]);
  assert.equal(
    supabase.rows.employment_contract_signings.find(
      (row) => row.id === "newer-qiunai-signing",
    ).form_data.report_channel_id,
    "909090909090909090",
  );
});

test("既有 players 依 Discord ID 全域找到後使用資料 ID 更新", async () => {
  const supabase = createSupabaseMock({
    signings: [
      {
        id: "existing-signing",
        organization_code: "deepnight",
        discord_id: "929292929292929292",
        discord_name: "舊資料員工",
        status: "signed",
        signed_at: "2026-09-13T00:00:00.000Z",
        form_data: { gender: "女" },
      },
    ],
    staffRecords: [
      {
        id: "existing-player-id",
        discord_id: "929292929292929292",
        discord_name: "舊資料員工",
        display_name: "舊資料員工",
        gender: "女",
        guild_id: null,
        report_channel_id: null,
        salary_channel_id: "939393939393939393",
      },
    ],
  });

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    businessGuildId: BUSINESS_GUILD_ID,
    ensureStaffReportChannel: async () => ({ id: "939393939393939393" }),
  });

  assert.equal(summary.provisioned, 1);
  assert.equal(supabase.inserts.length, 0);
  const playerUpdate = supabase.updates.find(
    (update) => update.table === "players",
  );
  assert.deepEqual(playerUpdate.filters, [
    { type: "eq", column: "id", value: "existing-player-id" },
  ]);
  assert.equal(playerUpdate.payload.report_channel_id, "939393939393939393");
});

test("跨店簽署者已有完整深夜 EIP 頻道時不重複建立", async () => {
  const supabase = createSupabaseMock({
    signings: [
      {
        id: "qiunai-existing",
        organization_code: "qiunai",
        discord_id: "343434343434343434",
        discord_name: "既有跨店員工",
        status: "activated",
        signed_at: "2026-09-13T00:00:00.000Z",
        form_data: { gender: "女", report_channel_id: "other-store-channel" },
      },
    ],
    staffRecords: [
      {
        id: "deepnight-player",
        guild_id: BUSINESS_GUILD_ID,
        discord_id: "343434343434343434",
        gender: "女",
        report_channel_id: "454545454545454545",
        salary_channel_id: "454545454545454545",
      },
    ],
  });
  let channelCalls = 0;

  const summary = await provisionSignedEmploymentReportChannels({
    supabase,
    organization: "deepnight",
    businessGuildId: BUSINESS_GUILD_ID,
    discordId: "343434343434343434",
    reuseSignedAcrossOrganizations: true,
    ensureStaffReportChannel: async () => {
      channelCalls += 1;
      return { id: "unexpected" };
    },
  });

  assert.deepEqual(summary, {
    checked: 0,
    provisioned: 0,
    manualRequired: 0,
    failed: 0,
    crossStoreReused: 0,
  });
  assert.equal(channelCalls, 0);
});

test("填單區搜尋及建立固定限定在深夜員工群", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "events", "workReportSystem.js"),
    "utf8",
  );
  assert.match(source, /reportGuildId/);
  assert.match(source, /String\(channel\.guildId\) === String\(reportGuildId\)/);
  assert.match(source, /const targetGuild = targetReportGuild/);
  assert.match(source, /if \(staff\.id\)/);
  assert.match(source, /reportChannelProvisionByStaffId/);
  assert.match(source, /Number\(overwrite\.type\) === 0/);
});
