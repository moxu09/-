const PROVISIONED_STATUS = "provisioned";
const MANUAL_STATUS = "manual_required";

function getEmploymentReportChannelGender(formData = {}) {
  const gender = String(formData.gender || "").trim();
  if (gender === "男" || gender.includes("男陪")) return "男";
  if (gender === "女" || gender.includes("女陪")) return "女";
  return null;
}

function isDuplicateKeyError(error) {
  return String(error?.code || "") === "23505";
}

function getPreferredStaffRecord(records, businessGuildId) {
  if (!records.length) return null;
  return (
    records.find(
      (record) => String(record.guild_id || "") === String(businessGuildId),
    ) || records[0]
  );
}

async function updateEmploymentStaffRecord({
  supabase,
  staffTable,
  existingStaff,
  signing,
  formData,
  channelId,
  gender,
}) {
  const discordName =
    String(signing.discord_name || formData.discord_name || signing.discord_id).trim() ||
    String(signing.discord_id);
  const payload = {
    report_channel_id: String(channelId),
    salary_channel_id: String(channelId),
    role_checked: true,
    updated_at: new Date().toISOString(),
  };

  if (!existingStaff.discord_name) payload.discord_name = discordName;
  if (!existingStaff.display_name) {
    payload.display_name =
      String(formData.display_name || signing.discord_name || discordName).trim() ||
      discordName;
  }
  if (!existingStaff.real_name && formData.real_name) {
    payload.real_name = formData.real_name;
  }
  if (!existingStaff.gender && (gender || formData.gender)) {
    payload.gender = gender || formData.gender;
  }
  if (!existingStaff.birthday && formData.birthday) {
    payload.birthday = formData.birthday;
  }
  if (!existingStaff.bank_name && formData.bank_name) {
    payload.bank_name = formData.bank_name;
  }
  if (!existingStaff.bank_account && formData.bank_account) {
    payload.bank_account = formData.bank_account;
  }

  const { data, error } = await supabase
    .from(staffTable)
    .update(payload)
    .eq("id", existingStaff.id)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) {
    throw new Error(`更新員工 ${signing.discord_id} 時找不到原始資料`);
  }
  return { action: "updated", staff: { ...existingStaff, ...payload } };
}

async function ensureEmploymentStaffRecord({
  supabase,
  staffTable,
  businessGuildId,
  signing,
  formData,
  existingStaff,
  channelId,
  gender,
}) {
  if (existingStaff) {
    return updateEmploymentStaffRecord({
      supabase,
      staffTable,
      existingStaff,
      signing,
      formData,
      channelId,
      gender,
    });
  }

  const discordId = String(signing.discord_id || "").trim();
  if (!discordId) throw new Error("簽署資料缺少 Discord ID");
  const discordName =
    String(signing.discord_name || formData.discord_name || discordId).trim() ||
    discordId;
  const now = new Date().toISOString();
  const insertPayload = {
    guild_id: String(businessGuildId),
    discord_id: discordId,
    discord_name: discordName,
    display_name:
      String(formData.display_name || signing.discord_name || discordName).trim() ||
      discordName,
    real_name: formData.real_name || null,
    gender: gender || formData.gender || null,
    birthday: formData.birthday || null,
    bank_name: formData.bank_name || null,
    bank_account: formData.bank_account || null,
    report_channel_id: String(channelId),
    salary_channel_id: String(channelId),
    role_checked: true,
    is_active: true,
    is_online: false,
    can_take_order: true,
    commission_tier: "auto",
    commission_note: null,
    allowed_services: [],
    created_at: now,
    updated_at: now,
  };
  const { data, error: insertError } = await supabase
    .from(staffTable)
    .insert(insertPayload)
    .select("id")
    .single();
  if (!insertError && data?.id) {
    return { action: "created", staff: { id: data.id, ...insertPayload } };
  }
  if (!isDuplicateKeyError(insertError)) {
    throw insertError || new Error(`新增員工 ${discordId} 後未取得資料 ID`);
  }

  // EIP 首次登入可能剛好與入群事件同時建立資料。重新讀取並更新該筆，
  // 避免把正常競態誤判為失敗或新增第二筆員工資料。
  const { data: racedRows, error: racedError } = await supabase
    .from(staffTable)
    .select("*")
    .eq("discord_id", discordId)
    .limit(10);
  if (racedError) throw racedError;
  const racedStaff = getPreferredStaffRecord(racedRows || [], businessGuildId);
  if (!racedStaff) throw insertError;
  return updateEmploymentStaffRecord({
    supabase,
    staffTable,
    existingStaff: racedStaff,
    signing,
    formData,
    channelId,
    gender,
  });
}

function deduplicateLatestSignings(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const discordId = String(row.discord_id || "");
    if (!discordId || seen.has(discordId)) return false;
    seen.add(discordId);
    return true;
  });
}

function selectSigningsForProvision({
  rows,
  organization,
  discordId,
  reuseSignedAcrossOrganizations,
}) {
  if (discordId && reuseSignedAcrossOrganizations) {
    const ownSigning = rows.find(
      (row) => row.organization_code === organization,
    );
    return ownSigning ? [ownSigning] : rows.slice(0, 1);
  }
  return deduplicateLatestSignings(rows);
}

function getEmploymentGenderFromMember(member) {
  const roleNames = member?.roles?.cache
    ?.map((role) => String(role.name || ""))
    .join(" ");
  if (roleNames?.includes("女陪")) return "女";
  if (roleNames?.includes("男陪")) return "男";
  return null;
}

function createEmploymentMemberHandler({ staffGuildId, provision }) {
  if (!staffGuildId || typeof provision !== "function") {
    throw new Error("缺少員工群入群處理設定");
  }
  const inFlightByDiscordId = new Map();

  return function handleEmploymentMember(member) {
    if (String(member?.guild?.id || "") !== String(staffGuildId)) {
      return Promise.resolve(null);
    }
    const discordId = String(member?.id || "").trim();
    if (!discordId) return Promise.resolve(null);
    const args = {
      discordId,
      genderOverride: getEmploymentGenderFromMember(member),
      reuseSignedAcrossOrganizations: true,
    };
    const existing = inFlightByDiscordId.get(discordId);
    if (existing) {
      // Discord 可能在短時間連發多次 GuildMemberUpdate。同一人的相同事件直接
      // 共用目前工作；只有首次事件尚無性別、後續取得性別時才補跑一次。
      if (
        args.genderOverride &&
        args.genderOverride !== existing.activeArgs.genderOverride
      ) {
        existing.pendingArgs = args;
      }
      return existing.task;
    }

    const state = { activeArgs: args, pendingArgs: null, task: null };
    inFlightByDiscordId.set(discordId, state);
    state.task = (async () => {
      let currentArgs = args;
      let result = null;
      while (currentArgs) {
        state.activeArgs = currentArgs;
        state.pendingArgs = null;
        result = await provision(currentArgs);
        currentArgs = state.pendingArgs;
      }
      return result;
    })().finally(() => {
      if (inFlightByDiscordId.get(discordId) === state) {
        inFlightByDiscordId.delete(discordId);
      }
    });
    return state.task;
  };
}

async function provisionSignedEmploymentReportChannels({
  supabase,
  ensureStaffReportChannel,
  organization = "deepnight",
  staffTable = "players",
  businessGuildId = "1501098191813214312",
  discordId = null,
  genderOverride = null,
  reuseSignedAcrossOrganizations = false,
  limit = 1000,
}) {
  if (!supabase || typeof ensureStaffReportChannel !== "function") {
    throw new Error("缺少簽署填單區建立服務");
  }

  let signingQuery = supabase
    .from("employment_contract_signings")
    .select(
      "id, organization_code, discord_id, discord_name, form_data, status, signed_at",
    )
    .in("status", ["signed", "activated"]);
  if (!reuseSignedAcrossOrganizations) {
    signingQuery = signingQuery.eq("organization_code", organization);
  }
  if (discordId) {
    signingQuery = signingQuery.eq("discord_id", String(discordId));
  }
  const { data, error } = await signingQuery
    .order("signed_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const signingRows = selectSigningsForProvision({
    rows: data || [],
    organization,
    discordId,
    reuseSignedAcrossOrganizations,
  });
  const discordIds = [
    ...new Set(signingRows.map((row) => row.discord_id).filter(Boolean)),
  ];
  const staffByDiscordId = new Map();
  if (discordIds.length) {
    const { data: staffRows, error: staffError } = await supabase
      .from(staffTable)
      .select("*")
      .in("discord_id", discordIds);
    if (staffError) throw staffError;
    for (const staff of staffRows || []) {
      const staffId = String(staff.discord_id || "");
      const current = staffByDiscordId.get(staffId) || [];
      current.push(staff);
      staffByDiscordId.set(staffId, current);
    }
  }

  const summary = {
    checked: 0,
    provisioned: 0,
    manualRequired: 0,
    failed: 0,
    crossStoreReused: 0,
  };
  for (const signing of signingRows) {
    const formData = signing.form_data || {};
    const ownsSigning = signing.organization_code === organization;
    const existingStaff = getPreferredStaffRecord(
      staffByDiscordId.get(String(signing.discord_id)) || [],
      businessGuildId,
    );
    // 另一店的 report_channel_id 指向另一個 Discord 群，絕不能拿來當成本店
    // 填單區或寫回本店資料。
    const formChannelId = ownsSigning
      ? String(formData.report_channel_id || "").trim()
      : "";
    const staffReportChannelId = String(
      existingStaff?.report_channel_id || "",
    ).trim();
    const staffSalaryChannelId = String(
      existingStaff?.salary_channel_id || "",
    ).trim();
    if (
      ownsSigning &&
      formData.report_channel_status === PROVISIONED_STATUS &&
      formChannelId &&
      existingStaff &&
      staffReportChannelId === formChannelId &&
      staffSalaryChannelId === formChannelId
    ) {
      continue;
    }
    if (
      !ownsSigning &&
      existingStaff &&
      staffReportChannelId &&
      staffSalaryChannelId === staffReportChannelId
    ) {
      continue;
    }
    summary.checked += 1;

    const gender =
      getEmploymentReportChannelGender(formData) ||
      getEmploymentReportChannelGender(existingStaff || {}) ||
      getEmploymentReportChannelGender({ gender: genderOverride });
    const knownChannelId =
      staffReportChannelId || staffSalaryChannelId || formChannelId;
    if (!gender && !knownChannelId) {
      if (ownsSigning && formData.report_channel_status === MANUAL_STATUS) {
        continue;
      }
      if (ownsSigning && formData.report_channel_status !== MANUAL_STATUS) {
        const nextFormData = {
          ...formData,
          report_channel_status: MANUAL_STATUS,
          report_channel_error: "簽署性別不是男或女，需由管理員選擇填單區分類",
        };
        const { error: updateError } = await supabase
          .from("employment_contract_signings")
          .update({
            form_data: nextFormData,
            updated_at: new Date().toISOString(),
          })
          .eq("id", signing.id);
        if (updateError) throw updateError;
      }
      summary.manualRequired += 1;
      continue;
    }

    try {
      const channel = await ensureStaffReportChannel({
        ...(existingStaff || {}),
        discord_id: signing.discord_id,
        discord_name: existingStaff?.discord_name || signing.discord_name,
        display_name: existingStaff?.display_name || signing.discord_name,
        real_name: existingStaff?.real_name || formData.real_name || null,
        gender: existingStaff?.gender || gender || formData.gender || null,
        report_channel_id:
          existingStaff?.report_channel_id || formChannelId || null,
        salary_channel_id:
          existingStaff?.salary_channel_id || formChannelId || null,
      });
      if (!channel?.id) throw new Error("建立填單區後未取得頻道 ID");

      const staffResult = await ensureEmploymentStaffRecord({
        supabase,
        staffTable,
        businessGuildId,
        signing,
        formData,
        existingStaff,
        channelId: channel.id,
        gender,
      });

      if (ownsSigning) {
        const nextFormData = {
          ...formData,
          ...(!formData.gender && gender ? { gender } : {}),
          report_channel_id: channel.id,
          report_channel_status: PROVISIONED_STATUS,
          report_channel_created_at:
            formData.report_channel_created_at || new Date().toISOString(),
        };
        delete nextFormData.report_channel_error;
        const { error: updateError } = await supabase
          .from("employment_contract_signings")
          .update({
            form_data: nextFormData,
            updated_at: new Date().toISOString(),
          })
          .eq("id", signing.id);
        if (updateError) throw updateError;
      } else {
        summary.crossStoreReused += 1;
      }

      staffByDiscordId.set(String(signing.discord_id), [staffResult.staff]);
      summary.provisioned += 1;
    } catch (provisionError) {
      summary.failed += 1;
      console.error(
        `[入職填單區] <@${signing.discord_id}> 建立失敗`,
        provisionError,
      );
    }
  }

  return summary;
}

module.exports = {
  MANUAL_STATUS,
  PROVISIONED_STATUS,
  createEmploymentMemberHandler,
  getEmploymentReportChannelGender,
  getEmploymentGenderFromMember,
  provisionSignedEmploymentReportChannels,
};
