function normalizeStaffSearchValue(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-Hant");
}

function splitStaffSearchInput(value) {
  return String(value || "")
    .split(/[\n,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getStaffSearchLabel(staff = {}) {
  return String(
    staff.display_name ||
      staff.real_name ||
      staff.discord_name ||
      staff.name ||
      staff.discord_id ||
      "未命名陪陪",
  );
}

function getStaffSearchValues(staff = {}) {
  return [
    staff.discord_id,
    staff.display_name,
    staff.real_name,
    staff.discord_name,
    staff.name,
  ]
    .map(normalizeStaffSearchValue)
    .filter(Boolean);
}

function getDiscordIdFromSearchTerm(value) {
  const match = String(value || "").trim().match(/^<@!?(\d{15,22})>$|^(\d{15,22})$/);
  return match?.[1] || match?.[2] || null;
}

function uniqueStaffRecords(records = []) {
  const seen = new Set();
  return records.filter((staff) => {
    const id = String(staff?.discord_id || "").trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function findStaffSearchMatches(records = [], term) {
  const staffRecords = uniqueStaffRecords(records);
  const discordId = getDiscordIdFromSearchTerm(term);
  if (discordId) {
    return staffRecords.filter(
      (staff) => String(staff.discord_id || "").trim() === discordId,
    );
  }
  const query = normalizeStaffSearchValue(term);
  if (!query) return [];
  const exact = staffRecords.filter((staff) =>
    getStaffSearchValues(staff).includes(query),
  );
  if (exact.length) return exact;
  return staffRecords.filter((staff) =>
    getStaffSearchValues(staff).some((value) => value.includes(query)),
  );
}

function resolveStaffSearchInput(records = [], value, options = {}) {
  const excludedIds = new Set(
    (options.excludeIds || []).map((id) => String(id || "").trim()),
  );
  const availableRecords = uniqueStaffRecords(records).filter(
    (staff) => !excludedIds.has(String(staff.discord_id || "").trim()),
  );
  const queries = splitStaffSearchInput(value);
  const resolvedIds = [];
  const ambiguousMatches = [];
  const missingQueries = [];
  for (const query of queries) {
    const matches = findStaffSearchMatches(availableRecords, query);
    if (matches.length === 1) resolvedIds.push(String(matches[0].discord_id));
    else if (matches.length > 1) ambiguousMatches.push({ query, matches });
    else missingQueries.push(query);
  }
  return {
    queries,
    resolvedIds: [...new Set(resolvedIds)],
    ambiguousMatches,
    missingQueries,
  };
}

module.exports = {
  findStaffSearchMatches,
  getStaffSearchLabel,
  normalizeStaffSearchValue,
  resolveStaffSearchInput,
  splitStaffSearchInput,
};
